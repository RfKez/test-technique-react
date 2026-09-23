'use strict';

const crypto = require('node:crypto');

const SIGNATURE_HEADER = 'x-payment-signature';
const SIGNATURE_TOLERANCE_S = 300;

function verifySignature(rawBody, header, secret, nowS = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !secret) return false;

  const parts = {};
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) parts[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isInteger(timestamp) || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  if (Math.abs(nowS - timestamp) > SIGNATURE_TOLERANCE_S) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');

  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function createPaymentWebhookHandler({ db, secret, logger = console }) {
  if (!secret) throw new Error('PAYMENT_WEBHOOK_SECRET manquant');

  return async function paymentWebhook(req, res) {
    if (!verifySignature(req.body, req.get(SIGNATURE_HEADER), secret)) {
      return res.status(401).send('invalid signature');
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).send('invalid json');
    }
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
      return res.status(400).send('invalid event');
    }
    
    if (event.type !== 'payment.succeeded') return res.status(200).send('ignored');

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      
      const inserted = await client.query(
        `INSERT INTO processed_webhook_events (event_id, type) VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.id, event.type],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(200).send('already processed');
      }

      
      const { rows } = await client.query(
        'SELECT id, status, amount FROM bookings WHERE id = $1 FOR UPDATE',
        [event.booking_id],
      );
      const booking = rows[0];

      let outcome;
      if (!booking) outcome = 'booking_not_found';
      else if (booking.status === 'paid') outcome = 'already_paid';
      else if (booking.status !== 'pending') outcome = 'unexpected_status'; 
      else if (Number(booking.amount) !== Number(event.amount)) outcome = 'amount_mismatch';
      else outcome = 'paid';

      if (outcome === 'paid') {
        await client.query("UPDATE bookings SET status = 'paid', paid_at = now() WHERE id = $1", [booking.id]);
        
        const payload = JSON.stringify({ bookingId: booking.id, eventId: event.id });
        await client.query(
          "INSERT INTO outbox (type, payload) VALUES ('send_receipt', $1), ('crm_notify_payment', $1)",
          [payload],
        );
      } else if (outcome !== 'already_paid') {
       
        logger.error('[webhook paiement] anomalie', { eventId: event.id, bookingId: event.booking_id, outcome });
      }

      await client.query('UPDATE processed_webhook_events SET outcome = $2 WHERE event_id = $1', [event.id, outcome]);
      await client.query('COMMIT');

      return res.status(200).send('ok');
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      logger.error('[webhook paiement] erreur de traitement', { eventId: event.id, error: err.message });
   
      return res.status(500).send('error');
    } finally {
      if (client) client.release();
    }
  };
}

module.exports = { createPaymentWebhookHandler, verifySignature, SIGNATURE_HEADER };
