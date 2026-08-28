const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../services/database');
const {
  asyncHandler,
  requireDatabase,
  validateDeviceLinkSignature,
  hashDeviceToken,
} = require('../middleware/validation');
const { strictLimiter, defaultLimiter } = require('../middleware/rateLimit');

/**
 * Mobile Connect, HolDEX half.
 *
 * What this can and cannot do is worth stating plainly, because it is not a login. This site has
 * no user accounts: identity is a wallet connected in the browser, and every write is signed by
 * that wallet at the moment it happens. A phone therefore cannot be "logged in" here - the key
 * stays in the desktop's wallet.
 *
 * What pairing DOES give the phone is a proof that this browser belongs to a particular wallet,
 * so personalised reads (watchlist, holdings) work immediately. Anything that writes still asks
 * the phone to connect a wallet of its own, because only the wallet can sign it. That boundary is
 * deliberate: a stolen device session must never become the ability to act as somebody.
 *
 * The desktop authenticates itself by signing a message naming the action - the same mechanism
 * this site already uses to authorise watchlist writes - so the two backends behind Mobile
 * Connect each verify the user independently and share no secret.
 */

/** How long a QR is worth scanning. Short: it is visible to whoever is in the room. */
const PAIRING_TTL_MS = 2 * 60 * 1000;

const newToken = () => crypto.randomBytes(32).toString('hex');
const isToken = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/**
 * A device row as the browser is allowed to see it. Note what is absent: session_token, even
 * hashed. A hash is still a fingerprint, and nothing on the client has any use for it.
 */
const toDeviceView = (d) => ({
  id: d.id,
  createdAt: d.created_at,
  activatedAt: d.activated_at,
  // Untrusted client text. Sent for display so a row is recognisable as "your iPhone";
  // the frontend renders it as text and never as markup.
  userAgent: d.user_agent,
});

router.use(requireDatabase);

/**
 * Desktop: mint a pairing code to put in a QR.
 *
 * strictLimiter because this is an unauthenticated-by-cookie endpoint that mints credentials;
 * the wallet signature is the gate, and the limiter bounds how fast someone can grind at it.
 */
router.post('/pair', strictLimiter, validateDeviceLinkSignature, asyncHandler(async (req, res) => {
  const wallet = req.linkedWallet;
  const pairingToken = newToken();

  await db.createDeviceSession(
    // Hashed at rest - see hashDeviceToken. The raw value goes back in this response and into the
    // QR's pixels, and nowhere else.
    hashDeviceToken(pairingToken),
    wallet,
    new Date(Date.now() + PAIRING_TTL_MS),
    req.ip || null,
    // The minting desktop, kept only until a phone redeems the code and replaces it with its own.
    // Useful for exactly one thing: telling an unclaimed code apart in the table.
    (req.get('user-agent') || '').slice(0, 300) || null
  );

  // The device list rides along on this response rather than living behind its own signed call.
  // Signatures are single-use, so a separate /list would mean a second wallet prompt just to
  // render the screen - and being asked to sign twice to look at one page teaches people to
  // approve prompts without reading them.
  const devices = await db.getDeviceSessionsByWallet(wallet);

  res.json({
    pairingToken,
    expiresInMs: PAIRING_TTL_MS,
    devices: devices.map(toDeviceView),
  });
}));

/**
 * Phone: redeem the code and receive a device session token of its own.
 *
 * Unauthenticated by design - the phone has nothing yet, and the code is the credential. The
 * token returned here is a NEW secret, not the one from the QR: see activateDeviceSession.
 */
router.post('/activate', strictLimiter, asyncHandler(async (req, res) => {
  const { pairingToken } = req.body || {};
  if (!isToken(pairingToken)) {
    return res.status(400).json({ error: 'Invalid pairing code' });
  }

  const sessionToken = newToken();
  // The user-agent recorded here is the PHONE's, overwriting the desktop's from /pair. That is
  // the whole point of the column: the list exists so somebody can pick their own phone out of
  // it, and a row labelled with the desktop that minted the code identifies nothing.
  const activated = await db.activateDeviceSession(
    hashDeviceToken(pairingToken),
    hashDeviceToken(sessionToken),
    (req.get('user-agent') || '').slice(0, 300) || null,
    req.ip || null
  );

  // One answer for every failure - wrong, already used, or expired are not distinctions a caller
  // is entitled to.
  if (!activated) {
    return res.status(400).json({ error: 'This code is not valid any more' });
  }

  res.json({ sessionToken, wallet: activated.wallet_address });
}));

/**
 * The phones currently linked to a wallet. Behind a signature: a wallet address is public, so
 * without one this would let anyone enumerate somebody else's devices.
 */
router.post('/list', defaultLimiter, validateDeviceLinkSignature, asyncHandler(async (req, res) => {
  const devices = await db.getDeviceSessionsByWallet(req.linkedWallet);
  res.json({ devices: devices.map(toDeviceView) });
}));

/** Revoke one phone, or all of them. Signed, and scoped to the signer's own devices. */
router.post('/revoke', strictLimiter, validateDeviceLinkSignature, asyncHandler(async (req, res) => {
  const { deviceId, all } = req.body || {};

  if (all === true) {
    const count = await db.deleteDeviceSessionsByWallet(req.linkedWallet);
    return res.json({ ok: true, revoked: count });
  }

  if (!Number.isInteger(deviceId)) {
    return res.status(400).json({ error: 'deviceId required' });
  }
  const deleted = await db.deleteDeviceSessionById(deviceId, req.linkedWallet);
  if (!deleted) return res.status(404).json({ error: 'No such device' });
  res.json({ ok: true, revoked: 1 });
}));

/**
 * Who a device session belongs to, for the phone to confirm its own pairing on load. Reads the
 * X-Device-Session header via the app-level resolver rather than taking a token in the body.
 */
router.get('/me', defaultLimiter, asyncHandler(async (req, res) => {
  if (!req.deviceWallet) return res.status(401).json({ error: 'Not linked' });
  res.json({ wallet: req.deviceWallet });
}));

module.exports = router;
