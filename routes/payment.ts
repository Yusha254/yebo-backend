import axios from 'axios';
import { Router } from "express";
import auth from '../middleware/auth';
import {v4 as uuidv4} from "uuid"
const router=Router()

  router.post("/create-checkout",auth,async(req,res)=>{
    try {
    const { amount, currency = "ZAR" } = req.body;
    const amountInCents = amount * 100
    const reference = uuidv4()
    const {data} = await axios.post(
      "https://payments.yoco.com/api/checkouts",
      {
        amount: amountInCents, 
        currency: currency,
        reference: reference ,
        cancelUrl: "https://yebovoucher.africa/api/payment/cancel",
        successUrl: "https://yebovoucher.africa/api/payment/success",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
     res.json({data});
  } catch (error:any) {
     res.status(400).json(error.response?.data || { message: "Error" });
  }
  })

  router.post("/paystack-topup", auth, async (req: any, res: any) => {
    try {
      const { email, id: user_id } = req.user!;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // We'll pass user_id inside metadata so the webhook knows who to credit
      const metadata = {
        type: "topup",
        user_id,
      };

      const { initializeTransaction, verifyTransaction } = await import("../utils/paystack");
      const paystackData = await initializeTransaction(email, amount, metadata);

      if (paystackData.data?.reference) {
        const { v4: uuidv4 } = require("uuid");
        const coin_id = uuidv4();
        // Insert pending topup
        const db = require("../config/db").default;
        await db.query(
          "INSERT INTO yebo_coins (user_uuid, coins_uuid, amount, action, status, reference_code) VALUES (?, ?, ?, 'topup', 'pending', ?)",
          [user_id, coin_id, amount, paystackData.data.reference]
        );
      }

      res.json(paystackData);
    } catch (error: any) {
      console.error("[TOPUP INIT ERROR]", error.message || error);
      res.status(500).json({ error: "Failed to initialize topup" });
    }
  });

  router.post("/verify-topup", auth, async (req: any, res: any) => {
    try {
      const { id: user_id } = req.user!;
      const { reference } = req.body;

      if (!reference) return res.status(400).json({ error: "Reference required" });

      const db = require("../config/db").default;
      const [rows]: any = await db.query(
        "SELECT * FROM yebo_coins WHERE user_uuid = ? AND reference_code = ? AND action = 'topup'",
        [user_id, reference]
      );

      if (rows.length === 0) return res.status(404).json({ error: "Topup not found" });
      if (rows[0].status === "success") return res.json({ success: true, status: "success" });

      const { verifyTransaction } = await import("../utils/paystack");
      const paystackData = await verifyTransaction(reference);

      if (paystackData.data?.status === "success") {
        await db.query("UPDATE yebo_coins SET status = 'success' WHERE coins_uuid = ?", [rows[0].coins_uuid]);
        await db.query("UPDATE users SET yeboCoins = yeboCoins + ? WHERE uuid = ?", [rows[0].amount, user_id]);
        return res.json({ success: true, status: "success" });
      }

      res.json({ success: false, status: paystackData.data?.status });
    } catch (error: any) {
      console.error("[TOPUP VERIFY ERROR]", error.message || error);
      res.status(500).json({ error: "Failed to verify topup" });
    }
  });

  export default router