import type { EngineInterface, Register } from 'claude-code'

/**
 * token-diet — cuts the two things that actually drive
 * Claude Code spend: full-resolution screenshots accumulating in context, and
 * long sessions re-reading a huge window on every request. It manages both on
 * its own:
 *
 * - clears the context when a new task starts in a big conversation,
 * - compacts when one task grows the context past a ceiling,
 * - compacts before the first prompt after a long break,
 * - asks for a CLAUDE.md in any project that lacks one,
 * - caps screenshot resolution, and reports what it did.
 *
 * Every helper that touches the engine is declared at the top of this file and
 * takes `$` as its first argument. The engine follows `$` statically, so that
 * it can list what a mod does before it is installed, and it refuses to load a
 * module that hands `$` to a closure or a callback it cannot follow. So: no
 * helpers nested inside `register`, and `$` is never passed to a function
 * parameter. Each helper handles its own failure instead.
 */

/** Scale applied to screenshots that ask for more. 1.0 is full resolution. */
const SCREENSHOT_SCALE = 0.5

/** Whether to ask for a CLAUDE.md in a project that has none. */
const ASK_FOR_CLAUDE_MD = true

/** A folder counts as a project only if one of these sits at its root. */
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'CMakeLists.txt']

// Thresholds count the conversation alone (the Messages row of /context).
// Tools, system prompt and skills are ~70-90K before the first word is typed
// and no /clear removes them, so counting them would clear every prompt.

/** A new task arriving over this much conversation clears it first. */
const CLEAR_AT = 60_000

/** One task growing past this much context gets compacted after the turn. */
const COMPACT_AT = 150_000

/**
 * Away this long, the prompt cache has expired and the next request re-writes
 * the whole window at write price anyway: a compact first makes that rewrite
 * a summary instead of the full history.
 */
const IDLE_MS = 30 * 60_000

/** Folders that are not a project: no CLAUDE.md is asked for there. */
const isProjectRoot = (root: string) => {
  const path = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return !/^[a-z]:$|^\/$|\/users\/[^/]+$|\/home\/[^/]+$|\/(documents|desktop|downloads|projects)$/i.test(path)
}

const CLAUDE_MD_ASK = [
  'This project has no CLAUDE.md. After you have finished the request above,',
  'write one at the project root from what you learned this session: what the',
  'project is, the non-obvious layout, how to build, test and run it, its',
  'conventions, and the things that would trip up a newcomer. Under 50 lines;',
  'leave out anything obvious from the file names. If the project is verified',
  'with screenshots, say they should be taken at scale 0.5.',
].join(' ')

const SAME_TASK = 'continues or follows up on the previous request'
const NEW_TASK = 'starts a different, unrelated task'

/** Screenshot tools that accept a `scale` argument we can turn down. */
const SCALABLE = new Set([
  'mcp__Claude_Browser__computer',
  'mcp__remote-devices__Claude_Browser__computer',
])

/** Screenshot tools with no scale knob — we can only count these. */
const UNSCALABLE = new Set([
  'mcp__computer-use__screenshot',
  'mcp__computer-use__zoom',
  'mcp__remote-devices__computer_screenshot',
])

/** Actions on the browser `computer` tool that return an image. */
const IMAGE_ACTIONS = new Set(['screenshot', 'zoom'])

let lastPrompt: string | undefined
let pending: string | undefined
let lastActive: number | undefined
let askedForClaudeMd = false
let shotsTaken = 0
let capsApplied = 0
let clears = 0
let compacts = 0
let compacting = false

// The fixed overhead of a session, used when the engine reports no breakdown.
let baseline: number | undefined
let baselineNoted = false

/** Recent decisions, written to token-diet.log beside the mod for checking. */
const traceLines: string[] = []
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

const pct = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n)}%`)
const kilo = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n / 1000)}K`)

const trace = async ($: EngineInterface, line: string) => {
  try {
    const at = new Date(await $.clock.now()).toISOString().slice(11, 19)
    traceLines.push(`${at} ${line}`)
    if (traceLines.length > 300) traceLines.splice(0, traceLines.length - 300)
    await $.fs.write(`${$.plugin.root}/token-diet.log`, `${traceLines.join('\n')}\n`)
  } catch {
    // tracing must never break a hook
  }
}

const sessionRoot = async ($: EngineInterface) => {
  try {
    return await $.session.root()
  } catch (err) {
    await trace($, `root failed: ${describe(err)}`)
    return undefined
  }
}

/**
 * The conversation's own tokens, or undefined when they can't be known.
 *
 * Tools, system prompt and skills are 70-90K before the first word is typed
 * and no /clear removes them, so a number that includes them would clear on
 * nearly every prompt. This never falls back to one: it uses the usage
 * breakdown's Messages row where the engine reports one, and otherwise
 * subtracts a baseline recorded the first time it measures. With neither it
 * returns undefined, and every threshold is skipped.
 */
const conversationTokens = async ($: EngineInterface): Promise<number | undefined> => {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const messages = context.breakdown?.categories?.find(c => c.name === 'Messages')

    if (messages?.tokens !== undefined) return messages.tokens
    if (context.tokens === undefined) return undefined

    // No breakdown. The first measurement of a session is the fixed overhead,
    // because it happens before the first turn has added anything to talk
    // about. A mod loaded into a session already under way measures too high a
    // baseline and reads the conversation as empty, which does nothing.
    if (baseline === undefined) {
      baseline = context.tokens

      if (!baselineNoted) {
        baselineNoted = true
        await trace($, `no usage breakdown; baseline ${kilo(baseline)} of fixed overhead`)
      }

      return 0
    }

    return Math.max(0, context.tokens - baseline)
  } catch (err) {
    await trace($, `usage failed: ${describe(err)}`)
    return undefined
  }
}

const classify = async ($: EngineInterface, text: string, options: string[]) => {
  try {
    return await $.model.classify(text, options)
  } catch (err) {
    await trace($, `classify failed: ${describe(err)}`)
    return undefined
  }
}

const claudeMdMissing = async ($: EngineInterface) => {
  try {
    const root = await $.session.root()
    if (!isProjectRoot(root)) return false

    // A folder is a project only if it carries one of these, so a parent that
    // merely holds projects doesn't get a CLAUDE.md of its own.
    let hasMarker = false
    for (const name of PROJECT_MARKERS) {
      if (await $.fs.exists(`${root}/${name}`)) {
        hasMarker = true
        break
      }
    }
    if (!hasMarker) return false

    return !(await $.fs.exists(`${root}/CLAUDE.md`)) && !(await $.fs.exists(`${root}/.claude/CLAUDE.md`))
  } catch (err) {
    await trace($, `claude.md check failed: ${describe(err)}`)
    return false
  }
}

/**
 * A dropped prompt is returned to the input box by the engine. Once the resend
 * has landed, that same text sits there looking unsent while it is already
 * running, so this takes it back out — but only when it is still the text we
 * held, so anything typed since is left alone.
 */
const clearPromptBox = async ($: EngineInterface, text: string) => {
  try {
    const box = (await $.prompt.read()) as unknown as string | { text?: string } | undefined
    const current = typeof box === 'string' ? box : box?.text
    if (current !== undefined && current.trim() === text.trim()) await $.prompt.fill({ text: '' })
  } catch (err) {
    await trace($, `clear prompt box failed: ${describe(err)}`)
  }
}

const resendPending = async ($: EngineInterface) => {
  const resent = pending
  if (resent === undefined) return

  try {
    await $.prompt.submit({ text: resent, asUser: true })
  } catch {
    pending = undefined
    $.ui.toast('token-diet: could not resend your prompt — please send it again.')
    return
  }

  await clearPromptBox($, resent)
}

const runThenResend = async ($: EngineInterface, command: 'clear' | 'compact') => {
  try {
    await $.command.run({ command })
  } catch (err) {
    await trace($, `/${command} failed: ${describe(err)}`)
  }

  // Whether the command landed or not, the prompt goes in afterwards, so the
  // person never has to retype it.
  await resendPending($)
}

/** Holds a prompt back, runs `/clear` or `/compact`, then sends it on. */
const holdFor = ($: EngineInterface, command: 'clear' | 'compact', text: string) => {
  pending = text
  void runThenResend($, command)

  return { drop: `token-diet: running /${command} first; resending this prompt after` }
}

const compactNow = async ($: EngineInterface, tokens: number) => {
  compacting = true
  compacts += 1
  $.ui.toast(`Conversation at ${kilo(tokens)} — compacting so the next request re-reads less.`)

  try {
    await $.command.run({ command: 'compact' })
  } catch {
    $.ui.toast(`Conversation at ${kilo(tokens)} — run /compact or /clear.`)
  }

  compacting = false
}

const report = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const minutes = Math.round(((await $.clock.now()) - usage.startedAt) / 60000)

  return [
    `talk      ${kilo(await conversationTokens($))} of conversation (what /clear and /compact shrink)`,
    `context   ${kilo(usage.context.tokens)} · ${pct(usage.context.percent)} of ${usage.context.window.toLocaleString()}`,
    `cost      ${usage.cost ? `$${usage.cost.usd.toFixed(2)}` : 'not tracked'} over ${minutes} min`,
    `shots     ${shotsTaken} taken, ${capsApplied} capped to ${SCREENSHOT_SCALE}`,
    `auto      ${clears} clears, ${compacts} compacts`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await trace($, `loaded in ${await sessionRoot($)}`)
    await $.command.register({
      name: 'diet',
      description: 'Show context fill, cost, and what token-diet has done',
    })

    return next(e)
  })

  // A /clear (ours or the person's) starts a new conversation with no
  // `session.start`: forget the old task.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      lastPrompt = undefined
      // askedForClaudeMd is kept on purpose: once per session, not once per
      // clear, so a project without one isn't asked over and over.
    }

    return next(e)
  })

  on('command.run', { command: 'diet' }, async $ => ({ text: await report($) }))

  // Every typed prompt: decide whether it is a new task (clear first) and
  // whether the session sat idle (compact first). Each helper fails on its own
  // and is traced; the prompt always goes through.
  on('prompt.submit', async ($, e, next) => {
    const isOurs = e.origin.kind === 'plugin' && pending !== undefined && e.text === pending
    // The desktop app and other SDK hosts send the person's messages as 'sdk'.
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'

    await trace($, `prompt from ${e.origin.kind}${e.command ? ' (command)' : ''}${e.isMeta ? ' (meta)' : ''}`)

    if (e.command || e.isMeta || (!isPerson && !isOurs)) return next(e)

    let context = e.context

    if (isOurs) {
      pending = undefined
    } else {
      // Any other prompt means the hold is over, whether the resend reached
      // this hook or not, so a left-over `pending` can't match later text.
      pending = undefined

      const tokens = await conversationTokens($)
      const now = await $.clock.now()
      const wasIdle = lastActive !== undefined && now - lastActive >= IDLE_MS

      await trace($, `conversation ${kilo(tokens)}, idle ${wasIdle}`)

      // An unknown conversation size is never acted on.
      // Prompts with images are left alone, since a resend would drop them.
      if (tokens !== undefined && tokens >= CLEAR_AT && !e.attachments?.length) {
        // A new task: everything already in the window would be re-read on
        // every request of a task that needs none of it.
        const previous = lastPrompt
        const verdict =
          previous === undefined
            ? undefined
            : await classify(
                $,
                `Previous request:
${previous.slice(0, 1500)}

New request:
${e.text.slice(0, 1500)}`,
                [SAME_TASK, NEW_TASK],
              )

        await trace($, `new task? ${verdict ?? 'no verdict'}`)

        if (verdict === NEW_TASK) {
          clears += 1
          $.ui.toast(`New task over ${kilo(tokens)} of conversation — clearing first, your prompt follows.`)
          return holdFor($, 'clear', e.text)
        }

        if (wasIdle) {
          compacts += 1
          lastPrompt = e.text
          $.ui.toast(`Back after a break with ${kilo(tokens)} of conversation — compacting first, your prompt follows.`)
          return holdFor($, 'compact', e.text)
        }
      }
    }

    // Every project gets a CLAUDE.md: asked for once per session, written
    // from what the session already learned, so it costs a few hundred
    // output tokens rather than a fresh exploration.
    if (ASK_FOR_CLAUDE_MD && !askedForClaudeMd) {
      askedForClaudeMd = true
      const missing = await claudeMdMissing($)

      await trace($, `claude.md missing: ${missing}`)

      if (missing) {
        context = [...(e.context ?? []), CLAUDE_MD_ASK]
        // The instruction is context, which only Claude reads. Say it in the
        // transcript too, so a CLAUDE.md never appears with no visible reason.
        $.ui.log('token-diet: no CLAUDE.md here — asked Claude to write one at the end of this turn.')
      }
    }

    lastPrompt = e.text
    return next(context === e.context ? e : { ...e, context })
  })

  // After a main-thread turn: compact when one task has grown past the ceiling.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) return result

    try {
      lastActive = await $.clock.now()
    } catch {
      // clock unavailable
    }

    const tokens = await conversationTokens($)

    // One at a time: the command isn't awaited, so two turns finishing in
    // quick succession over the ceiling would otherwise both start one.
    if (tokens !== undefined && tokens >= COMPACT_AT && !compacting) void compactNow($, tokens)

    return result
  })

  // Each screenshot re-sends with every later request in the session, so cap
  // them at the source.
  // This hook never denies — the worst case is a screenshot at full size, so
  // every decision is wrapped and falls through to `next(e)` untouched.
  on('tool.call', ($, e, next) => {
    let capped = e

    try {
      const args = e as unknown as { action?: string; scale?: number }
      const isScalable = SCALABLE.has(e.tool) && IMAGE_ACTIONS.has(args.action ?? '')

      if (UNSCALABLE.has(e.tool)) shotsTaken += 1
      else if (isScalable) {
        shotsTaken += 1

        if (args.scale === undefined || args.scale > SCREENSHOT_SCALE) {
          capsApplied += 1
          capped = { ...e, scale: SCREENSHOT_SCALE } as typeof e
        }
      }
    } catch {
      capped = e
    }

    return next(capped)
  })

  // The status line is the always-on /diet: fill, cost, shots.
  on('session.measure', ($, e, next) => {
    const cost = e.cost ? ` · $${e.cost.usd.toFixed(2)}` : ''
    const shots = shotsTaken ? ` · ${shotsTaken} shots` : ''

    $.ui.status(`ctx ${kilo(e.context.tokens)} ${pct(e.context.percent)}${cost}${shots}`)

    return next(e)
  })
}
