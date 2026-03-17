import { Request, Router } from "express";
import db from "../config/db";

import axios from 'axios';
import auth, { IUser } from '../middleware/auth';

const router=Router()

router.post("/withdraw", auth, async (req:Request&IUser,res) => {
    const { id: userId } = req.user!;
    const { amount, bank_id } = req.body;
  
    const [rows] = await db.query("SELECT recipient_code FROM user_bank WHERE id = ? AND user_id = ?", [bank_id, userId]);
    if (rows.length === 0) { 
        res.status(404).send({ error: "Bank not found" });
        return
        }
    const recipient_code = rows[0].recipient_code;
  
    const response = await axios.post(
      "https://api.paystack.co/transfer",
      {
        source: "balance",
        amount: amount * 100,
        recipient: recipient_code,
        reason: "Withdrawal to selected account"
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );
  
    res.send(response.data);
  });
  