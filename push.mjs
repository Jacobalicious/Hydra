// Phone notifications (Web Push) with no extra packages: VAPID signing (RFC 8292)
// and aes128gcm payload encryption (RFC 8291) done with node:crypto. The push
// services (Google's, Apple's) only ever see the encrypted payload.
import fs from 'node:fs';
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const SUBJECT = 'mailto:multiclaude@example.com';   // push services want some contact; this needn't be real

export function makePush(file) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!d.privateJwk) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    d = { privateJwk: privateKey.export({ format: 'jwk' }), subs: [] };
  }
  d.subs ||= [];
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(d, null, 2)); } catch {} };
  save();

  const priv = crypto.createPrivateKey({ key: d.privateJwk, format: 'jwk' });
  const pubRaw = Buffer.concat([Buffer.from([4]), Buffer.from(d.privateJwk.x, 'base64url'), Buffer.from(d.privateJwk.y, 'base64url')]);
  const publicKey = b64u(pubRaw);

  const jwts = new Map();   // push service origin -> { token, until }
  function vapid(endpoint) {
    const aud = new URL(endpoint).origin;
    const c = jwts.get(aud);
    if (c && c.until > Date.now() + 60e3) return c.token;
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp, sub: SUBJECT }))}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: priv, dsaEncoding: 'ieee-p1363' });
    const token = `${data}.${b64u(sig)}`;
    jwts.set(aud, { token, until: exp * 1000 });
    return token;
  }

  function encrypt(sub, payload) {
    const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
    const auth = Buffer.from(sub.keys.auth, 'base64url');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const secret = ecdh.computeSecret(uaPublic);
    const salt = crypto.randomBytes(16);
    const hkdf = (ikm, salt, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
    const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
    const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const sealed = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = asPublic.length;
    return Buffer.concat([head, asPublic, sealed]);
  }

  async function sendOne(sub, payload) {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Authorization: `vapid t=${vapid(sub.endpoint)}, k=${publicKey}` },
      body: encrypt(sub, payload),
      signal: AbortSignal.timeout(15000),
    });
    // 404/410: that phone unsubscribed or the browser was reset; forget it.
    if (r.status === 404 || r.status === 410) { d.subs = d.subs.filter(s => s.endpoint !== sub.endpoint); save(); }
    return r.ok;
  }

  return {
    publicKey,
    count: () => d.subs.length,
    add(sub) {
      const endpoint = String(sub?.endpoint || ''), keys = sub?.keys || {};
      if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) throw new Error('That is not a push subscription.');
      d.subs = d.subs.filter(s => s.endpoint !== endpoint);
      d.subs.push({ endpoint, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, added: Date.now() });
      save();
    },
    remove(endpoint) { d.subs = d.subs.filter(s => s.endpoint !== endpoint); save(); },
    // msg = { title, body, project }. only = one endpoint (the test button), else every phone.
    async send(msg, only = null) {
      const payload = JSON.stringify({ ...msg, body: String(msg.body || '').slice(0, 600) });
      const list = d.subs.filter(s => !only || s.endpoint === only);
      const res = await Promise.all(list.map(s => sendOne(s, payload).catch(() => false)));
      return { sent: res.filter(Boolean).length, of: list.length };
    },
    _encrypt: encrypt, _vapid: vapid,   // for the self-test
  };
}
