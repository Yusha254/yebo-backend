import { Request, Response, Router } from "express";
import crypto from "crypto";
import db from "../config/db";

const router = Router();
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

router.post("/paystack", async (req: Request, res: Response) => {
  // 1. Verify Paystack Signature
  const hash = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    res.status(401).send("Invalid signature");
    return;
  }

  const event = req.body;

  // 2. Handle relevant event
  if (event.event === "charge.success") {
    const { reference, metadata, amount } = event.data;
    const escrow_id = metadata?.escrow_id;
    const type = metadata?.type;
    const user_id = metadata?.user_id;

    if (escrow_id) {
      try {
        // Update escrow transaction to 'held'
        const [result]: any = await db.query(
          "UPDATE escrow_transactions SET status = 'held', payment_ref = ? WHERE escrow_id = ? AND status = 'pending_payment'",
          [reference, escrow_id]
        );

        if (result.affectedRows > 0) {
          console.log(`[Webhook] Escrow ${escrow_id} updated to HELD via Paystack ref ${reference}`);
        } else {
          console.log(`[Webhook] Escrow ${escrow_id} was already updated or not found`);
        }
      } catch (error) {
        console.error("[Webhook] Error updating escrow transaction:", error);
      }
    } else if (type === "topup" && user_id) {
      try {
         // The amount is in cents/kobo from Paystack, so divide by 100 for actual currency balance
         const actualAmount = amount / 100;
         await db.query(`UPDATE users SET yeboCoins = yeboCoins + ? WHERE uuid = ?`, [actualAmount, user_id]);
         console.log(`[Webhook] Topup successful for user ${user_id}, amount added: ${actualAmount}`);
         
         const { v4: uuidv4 } = require("uuid");
         const coin_id = uuidv4();
         await db.query(
           "INSERT INTO yebo_coins (user_uuid, coins_uuid, amount, action, status, reference_code) VALUES (?, ?, ?, 'topup', 'success', ?)",
           [user_id, coin_id, actualAmount, reference]
         );
      } catch (error) {
        console.error("[Webhook] Error processing topup account credit:", error);
      }
    }
  }

  // Always respond with 200 OK to Paystack
  res.sendStatus(200);
});

export default router;
