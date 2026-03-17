import { Request, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/db";
import auth, { IUser } from "../middleware/auth";
import {
  validateCreateOffer,
  validateTakeOffer,
  validateEscrowAction,
} from "../config/validators";
import { initializeTransaction, initiateTransfer } from "../utils/paystack";

const router = Router();

// ─────────────────────────────────────────────────────────────
// SELLER ENDPOINTS
// ─────────────────────────────────────────────────────────────
router.post("/offer", auth, async (req: Request & IUser, res: any) => {
  const validate = validateCreateOffer.safeParse(req.body);
  if (!validate.success) {
    res.status(400).json({ error: validate.error.issues });
    return;
  }

  const { id: seller_id } = req.user!;
  const { network_id, seller_phone, airtime_amount, asking_price } = req.body;

  try {
    // Make sure this phone belongs to the logged-in seller
    const [phoneRows]: any = await db.query(
      "SELECT airtime, uuid FROM phone_numbers WHERE phone_number = ?",
      [seller_phone]
    );
    if (phoneRows.length === 0) {
      res.status(400).json({ error: "Phone number not found in your account" });
      return;
    }
    if (phoneRows[0].uuid !== seller_id) {
      res.status(403).json({ error: "This phone number does not belong to you" });
      return;
    }
    if (phoneRows[0].airtime < airtime_amount) {
      res
        .status(400)
        .json({ error: "You don't have enough airtime balance for this offer" });
      return;
    }

    const offer_id = uuidv4();
    await db.query(
      `INSERT INTO marketplace_offers 
       (offer_id, seller_id, network_id, seller_phone, airtime_amount, asking_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [offer_id, seller_id, network_id, seller_phone, airtime_amount, asking_price]
    );

    res.status(201).json({ success: true, offer_id });
  } catch (error) {
    console.error("Create offer error:", error);
    res.status(500).json({ error: "Failed to create offer" });
  }
});

router.get("/my-offers", auth, async (req: Request & IUser, res: any) => {
  const { id: seller_id } = req.user!;
  try {
    const [rows] = await db.query(
      `SELECT 
         mo.offer_id, mo.seller_phone, mo.airtime_amount, mo.asking_price,
         mo.status, mo.created_at,
         isps.name AS network_name,
         et.escrow_id
       FROM marketplace_offers mo
       JOIN isps ON mo.network_id = isps.network_id
       LEFT JOIN escrow_transactions et ON mo.offer_id = et.offer_id
       WHERE mo.seller_id = ?
       ORDER BY mo.created_at DESC`,
      [seller_id]
    );
    res.json(rows);
  } catch (error) {
    console.error("My offers error:", error);
    res.status(500).json({ error: "Failed to fetch offers" });
  }
});

router.delete("/offer/:offer_id", auth, async (req: Request & IUser, res: any) => {
  const { id: seller_id } = req.user!;
  const { offer_id } = req.params;

  try {
    const [rows]: any = await db.query(
      "SELECT status FROM marketplace_offers WHERE offer_id = ? AND seller_id = ?",
      [offer_id, seller_id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Offer not found" });
      return;
    }
    if (rows[0].status !== "active") {
      res.status(400).json({
        error: `Cannot cancel an offer with status '${rows[0].status}'`,
      });
      return;
    }

    await db.query(
      "UPDATE marketplace_offers SET status = 'cancelled' WHERE offer_id = ?",
      [offer_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Cancel offer error:", error);
    res.status(500).json({ error: "Failed to cancel offer" });
  }
});

// ─────────────────────────────────────────────────────────────
// BUYER ENDPOINTS
// ─────────────────────────────────────────────────────────────
router.get("/offers", auth, async (req: Request & IUser, res: any) => {
  const { id: viewer_id } = req.user!;
  const { network_id, max_amount } = req.query;

  try {
    // Build query dynamically based on optional filters
    let query = `
      SELECT
        mo.offer_id, mo.seller_phone, mo.airtime_amount, mo.asking_price,
        mo.created_at,
        isps.name AS network_name, isps.network_id
      FROM marketplace_offers mo
      JOIN isps ON mo.network_id = isps.network_id
      WHERE mo.status = 'active'
        AND mo.seller_id != ?`;   // buyers shouldn't see their own listings in buyer mode

    const params: any[] = [viewer_id];

    if (network_id) {
      query += " AND mo.network_id = ?";
      params.push(network_id);
    }
    if (max_amount) {
      query += " AND mo.airtime_amount <= ?";
      params.push(Number(max_amount));
    }

    query += " ORDER BY mo.asking_price ASC"; // cheapest offers first

    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error("Browse offers error:", error);
    res.status(500).json({ error: "Failed to fetch offers" });
  }
});

router.post("/take-offer", auth, async (req: Request & IUser, res: any) => {
  const validate = validateTakeOffer.safeParse(req.body);
  if (!validate.success) {
    res.status(400).json({ error: validate.error.issues });
    return;
  }

  const { id: buyer_id } = req.user!;
  const { offer_id } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock + read the offer row
    const [offerRows]: any = await conn.query(
      "SELECT * FROM marketplace_offers WHERE offer_id = ? FOR UPDATE",
      [offer_id]
    );
    if (offerRows.length === 0) {
      await conn.rollback();
      res.status(404).json({ error: "Offer not found" });
      return;
    }
    const offer = offerRows[0];

    if (offer.status !== "active") {
      await conn.rollback();
      res.status(400).json({ error: "This offer is no longer available" });
      return;
    }
    if (offer.seller_id === buyer_id) {
      await conn.rollback();
      res.status(400).json({ error: "You cannot take your own offer" });
      return;
    }

    // Check buyer's Yebo coins balance
    const [buyerRows]: any = await conn.query(
      "SELECT yeboCoins FROM users WHERE uuid = ? FOR UPDATE",
      [buyer_id]
    );
    if (buyerRows.length === 0) {
      await conn.rollback();
      res.status(404).json({ error: "Buyer account not found" });
      return;
    }
    const buyerCoins = Number(buyerRows[0].yeboCoins) || 0;
    if (buyerCoins < offer.asking_price) {
      await conn.rollback();
      res.status(400).json({ error: `Not enough Yebo Coins. You have Y.${buyerCoins.toFixed(2)} but need Y.${offer.asking_price.toFixed(2)}.` });
      return;
    }

    // Deduct from buyer
    const newBuyerCoins = buyerCoins - offer.asking_price;
    await conn.query(
      "UPDATE users SET yeboCoins = ? WHERE uuid = ?",
      [newBuyerCoins, buyer_id]
    );

    // Mark the offer as taken so no one else can grab it
    await conn.query(
      "UPDATE marketplace_offers SET status = 'taken' WHERE offer_id = ?",
      [offer_id]
    );

    // Create the escrow record directly in 'held' status since buyer has already paid in Yebo Coins
    const escrow_id = uuidv4();
    await conn.query(
      `INSERT INTO escrow_transactions 
       (escrow_id, offer_id, buyer_id, seller_id, amount_held, status)
       VALUES (?, ?, ?, ?, ?, 'held')`,
      [escrow_id, offer_id, buyer_id, offer.seller_id, offer.asking_price]
    );

    await conn.commit();

    res.status(201).json({
      success: true,
      escrow_id,
      amount_paid: offer.asking_price,
      seller_phone: offer.seller_phone,
      airtime_amount: offer.airtime_amount,
    });
  } catch (error) {
    await conn.rollback();
    console.error("Take offer error:", error);
    res.status(500).json({ error: "Failed to take offer" });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────
// ESCROW ENDPOINTS
// ─────────────────────────────────────────────────────────────
// Old Paystack pay-init / verify routes removed

router.put(
  "/escrow/seller-confirm/:escrow_id",
  auth,
  async (req: Request & IUser, res: any) => {
    const { id: seller_id } = req.user!;
    const { escrow_id } = req.params;

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [rows]: any = await conn.query(
        "SELECT * FROM escrow_transactions WHERE escrow_id = ? AND seller_id = ?",
        [escrow_id, seller_id]
      );
      if (rows.length === 0) {
        await conn.rollback();
        res.status(404).json({ error: "Escrow not found" });
        return;
      }
      if (rows[0].status !== "held") {
        await conn.rollback();
        res.status(400).json({ error: "Funds are not yet held in escrow" });
        return;
      }

      const both_confirmed = rows[0].buyer_confirmed === 1;

      await conn.query(
        "UPDATE escrow_transactions SET seller_confirmed = 1 WHERE escrow_id = ?",
        [escrow_id]
      );

      if (both_confirmed) {
        // Both sides confirmed — complete the transaction
        await conn.query(
          "UPDATE escrow_transactions SET status = 'released' WHERE escrow_id = ?",
          [escrow_id]
        );
        await conn.query(
          "UPDATE marketplace_offers SET status = 'completed' WHERE offer_id = ?",
          [rows[0].offer_id]
        );
        
        // --- YEBO COINS PAYOUT LOGIC ---
        const amount_held = rows[0].amount_held;
        const payout = Math.floor(amount_held * 0.75);
        const fee = Math.floor(amount_held * 0.25);

        // Credit seller
        await conn.query(
          "UPDATE users SET yeboCoins = yeboCoins + ? WHERE uuid = ?",
          [payout, seller_id]
        );

        // Record profit
        await conn.query(
          "INSERT INTO profits (uuid, transaction_uuid, amount) VALUES (?, ?, ?)",
          [seller_id, escrow_id, fee]
        );
      }

      await conn.commit();
      res.json({ success: true, released: both_confirmed });
    } catch (error) {
      await conn.rollback();
      console.error("Seller confirm error:", error);
      res.status(500).json({ error: "Failed to confirm" });
    } finally {
      conn.release();
    }
  }
);

router.put(
  "/escrow/buyer-confirm/:escrow_id",
  auth,
  async (req: Request & IUser, res: any) => {
    const { id: buyer_id } = req.user!;
    const { escrow_id } = req.params;

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [rows]: any = await conn.query(
        "SELECT * FROM escrow_transactions WHERE escrow_id = ? AND buyer_id = ?",
        [escrow_id, buyer_id]
      );
      if (rows.length === 0) {
        await conn.rollback();
        res.status(404).json({ error: "Escrow not found" });
        return;
      }
      if (rows[0].status !== "held") {
        await conn.rollback();
        res.status(400).json({ error: "Funds are not yet held in escrow" });
        return;
      }

      const both_confirmed = rows[0].seller_confirmed === 1;

      await conn.query(
        "UPDATE escrow_transactions SET buyer_confirmed = 1 WHERE escrow_id = ?",
        [escrow_id]
      );

      if (both_confirmed) {
        await conn.query(
          "UPDATE escrow_transactions SET status = 'released' WHERE escrow_id = ?",
          [escrow_id]
        );
        await conn.query(
          "UPDATE marketplace_offers SET status = 'completed' WHERE offer_id = ?",
          [rows[0].offer_id]
        );

        // --- YEBO COINS PAYOUT LOGIC ---
        const amount_held = rows[0].amount_held;
        const payout = Math.floor(amount_held * 0.75);
        const fee = Math.floor(amount_held * 0.25);

        // Credit seller
        await conn.query(
          "UPDATE users SET yeboCoins = yeboCoins + ? WHERE uuid = ?",
          [payout, rows[0].seller_id]
        );

        // Record profit
        await conn.query(
          "INSERT INTO profits (uuid, transaction_uuid, amount) VALUES (?, ?, ?)",
          [rows[0].seller_id, escrow_id, fee]
        );
      }

      await conn.commit();
      res.json({ success: true, released: both_confirmed });
    } catch (error) {
      await conn.rollback();
      console.error("Buyer confirm error:", error);
      res.status(500).json({ error: "Failed to confirm" });
    } finally {
      conn.release();
    }
  }
);

router.put(
  "/escrow/dispute/:escrow_id",
  auth,
  async (req: Request & IUser, res: any) => {
    const { id: user_id } = req.user!;
    const { escrow_id } = req.params;

    try {
      const [rows]: any = await db.query(
        `SELECT * FROM escrow_transactions 
         WHERE escrow_id = ? AND (buyer_id = ? OR seller_id = ?)`,
        [escrow_id, user_id, user_id]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Escrow not found" });
        return;
      }
      if (rows[0].status !== "held") {
        res.status(400).json({ error: "Can only dispute an escrow with held funds" });
        return;
      }

      await db.query(
        "UPDATE escrow_transactions SET status = 'dispute' WHERE escrow_id = ?",
        [escrow_id]
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Dispute error:", error);
      res.status(500).json({ error: "Failed to raise dispute" });
    }
  }
);

router.get(
  "/escrow/:escrow_id",
  auth,
  async (req: Request & IUser, res: any) => {
    const { id: user_id } = req.user!;
    const { escrow_id } = req.params;

    try {
      const [rows]: any = await db.query(
        `SELECT 
           et.escrow_id, et.status, et.amount_held, et.payment_ref,
           et.buyer_confirmed, et.seller_confirmed, et.created_at,
           mo.airtime_amount, mo.seller_phone, mo.asking_price,
           isps.name AS network_name
         FROM escrow_transactions et
         JOIN marketplace_offers mo ON mo.offer_id = et.offer_id
         JOIN isps ON mo.network_id = isps.network_id
         WHERE et.escrow_id = ? AND (et.buyer_id = ? OR et.seller_id = ?)`,
        [escrow_id, user_id, user_id]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Escrow not found" });
        return;
      }
      res.json(rows[0]);
    } catch (error) {
      console.error("Get escrow error:", error);
      res.status(500).json({ error: "Failed to fetch escrow" });
    }
  }
);

export default router;
