import bcrypt from 'bcrypt';
import { Request, Router } from "express";
import jwt from 'jsonwebtoken';
import db from "../config/db";

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import sendEmail from '../config/emailsender';
import generateSecureOtp from '../config/otp';
import cleanEmail from "../config/utils";
import { ValData, validateCheckEmail, validateEmailReg, validateEmailVerify, validateLogin } from "../config/validators";
import auth, { IUser } from '../middleware/auth';
import { createTransferRecipient } from "../utils/paystack";

const router = Router()
const SA_BANKS: { name: string, code: string }[] = [
  { name: "ABSA Bank", code: "632005" },
  { name: "Capitec Bank", code: "470010" },
  { name: "FNB (First National Bank)", code: "250655" },
  { name: "Nedbank", code: "198765" },
  { name: "Standard Bank", code: "051001" },
  { name: "Investec", code: "580105" },
  { name: "Bidvest Bank", code: "462" },
  { name: "African Bank", code: "507655" },
];
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM users');
    res.send(rows)
  } catch (error) {
    res.send(error)
  }
})
router.post('/register', async (req: Request & ValData, res: any) => {

  const validate = validateEmailReg.safeParse(req.body)
  if (!validate.success) {
    console.error("Validation failed:", validate.error.message);
    res.status(400).send(validate.error.message)
    return
  }
  const { firstname, lastname, email, password, address_line, city, postal_code, state } = req.body;
  try {
    // Check if user already exists
    const [existing] = await db.query('SELECT uuid FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const uuid = uuidv4();
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newMail = cleanEmail(email)
    const fullname = `${firstname} ${lastname}`;
    const otp = generateSecureOtp(6);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000 * 6);
    const [result] = await db.query(`
        INSERT INTO users (uuid,fullname, email, passwordHash,authProvider,emailVerCode,expiry_date,address,city,state,postal)
        VALUES (?, ?, ?, ?,?,?,?,?,?,?,?)
      `, [uuid, fullname, newMail, hashedPassword, 'email', otp, expiresAt, address_line, city, state, postal_code]);
    if (result.affectedRows > 0) {
      sendEmail(newMail, "verify", otp)
      res.status(201).json({ message: 'success' });
    }

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});
router.post("/login", async (req, res) => {
  const validation = validateLogin.safeParse(req.body);
  if (!validation.success) {
    res.status(400).send(validation.error.message);
    return;
  }
  const { email, password } = req.body;
  const cleanedEmail = cleanEmail(email);

  try {
    const [rows]: any = await db.query('SELECT * FROM users WHERE email = ?', [cleanedEmail]);

    if (rows.length === 0) {
      res.status(400).json({ error: "Invalid email or password" });
      return
    }

    const user = rows[0];

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      res.status(400).json({ error: "Invalid email or password" });
      return
    }
    const token = jwt.sign(
      { id: user.uuid, email: user.email, isVerified: user.isEmailVerified },
      process.env.JWT_SECRET as string
    );

    delete user.password;
    res.header("x-auth", token).json({ success: true, user })
  } catch (error) {
    console.log(error)
    res.status(500).send("Server error");
    return
  }
});
router.post('/check_email', async (req, res) => {
  const validation = validateCheckEmail.safeParse(req.body)
  if (!validation.success) {
    res.status(400).send(validation.error.message);
    return;
  }
  const { email } = req.body;
  const cleanedEmail = cleanEmail(email);
  try {
    const [rows] = await db.query("SELECT email FROM users where email=?", [cleanedEmail])
    if (rows.length < 1) {
      res.status(200).json({ success: true })
      return
    }
    else {
      res.status(400).json({ error: "user already registered" })
      return
    }
  } catch (error) {
    res.send(error)
  }
})
router.post('/send_reset_email', async (req, res) => {
  const validation = validateCheckEmail.safeParse(req.body)
  if (!validation.success) {
    res.status(400).send(validation.error.message);
    return;
  }
  const { email } = req.body;
  const cleanedEmail = cleanEmail(email);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000 * 6);
  const otp = generateSecureOtp(6);
  try {
    const [rows] = await db.query("SELECT email FROM users where email=?", [cleanedEmail])
    if (rows.length >= 1) {
      const [result] = await db.query("UPDATE users SET email_reset_code = ? , reset_expiry_at = ? WHERE email = ?", [otp, expiresAt, cleanedEmail])
      console.log(otp)
      // sendEmail(email,"reset",otp)
      if (result.affectedRows > 0) {
        res.send({ success: true })
        return
      } else {
        res.status(400).send('error sending email')
        return
      }
    }
    else {
      res.status(400).json({ error: "user doesn't exist" })
      return
    }
  } catch (error) {
    res.send(error)
  }
})
router.get('/me', auth, async (req: Request & IUser, res) => {
  const { id: uuid } = req.user!
  try {
    const [rows] = await db.query("SELECT * FROM users where uuid=?", [uuid])
    if (rows.length < 1) {
      res.status(404).send("user doesn't exist ")
      return
    }
    const user = rows[0]
    delete user.passwordHash
    res.send(user)
  } catch (error) {
    console.log(error)
    res.send(error)
  }
})
router.post("/verify_code", auth, async (req: Request & IUser, res) => {
  const { id: uuid, email } = req.user!
  const validation = validateEmailVerify.safeParse(req.body)
  if (!validation.success) {
    res.status(400).send(validation.error.message);
    return;
  }
  const { code } = req.body
  const cleanedEmail = cleanEmail(email);
  try {
    const [rows] = await db.query("SELECT * FROM users where email=? AND uuid = ?", [cleanedEmail, uuid])
    if (rows.length < 1) {
      res.send("user doesnt exist").status(404)
      return
    }
    const dbCode = rows[0].emailVerCode
    const expiryDate = new Date(rows[0].expiry_date)
    const dateNow = new Date()
    if (dateNow > expiryDate) {
      res.status(400).send('invalid code . code has expired')
      return
    }
    if (dbCode == code) {
      const [result] = await db.query("UPDATE users SET isEmailVerified = 1 where email =?", [cleanedEmail])
      if (result.affectedRows > 0) {
        sendEmail(cleanedEmail, "welcome")
        res.json({ "success": true })
        return
      }
    }
    else {
      res.status(400).send("code is invalid")
      return
    }
  } catch (error) {
    res.send(error)
  }
})
router.get("/get_code", auth, async (req: Request & IUser, res) => {
  const { id: uuid, email } = req.user!

  const cleanedEmail = cleanEmail(email);
  try {
    const [rows] = await db.query("SELECT * FROM users WHERE email=? AND uuid = ?", [cleanedEmail, uuid])
    if (rows.length < 1) {
      res.send("user doesnt exist").status(404)
      return
    }
    const dbCode = rows[0].emailVerCode
    const expiryDate = new Date(rows[0].expiry_date)
    const dateNow = new Date()
    const otp = generateSecureOtp(6);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000 * 6);


    if (dateNow > expiryDate) {
      const [result] = await db.query("UPDATE users SET emailVerCode = ? , expiry_date = ? WHERE email = ? ", [otp, expiresAt, cleanedEmail])
      sendEmail(cleanedEmail, "verify", otp)
      if (result.affectedRows > 0) {
        res.send(result)
      }
      return
    } else {
      sendEmail(cleanedEmail, "verify", otp)
    }
    res.send({ "success": true })

  } catch (error) {
    res.send("err")
  }
})
router.post("/token", auth, async (req: Request & IUser, res) => {
  const { id: uuid } = req.user!
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: "Missing uuid or token" });
    return
  }
  try {
    const [result] = await db.query('INSERT INTO user_push_tokens (uuid, token) VALUES (?, ?) ON DUPLICATE KEY UPDATE uuid = VALUES(uuid)', [uuid, token])
    if (result.affectedRows > 0) {
      res.send(result)
    }
  } catch (error) {

  }
})

router.put("/reset-email", async (req, res) => {
  const { code, email, password } = req.body;
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash(password, saltRounds);
  const cleanedEmail = cleanEmail(email);
  try {
    const [result] = await db.query("UPDATE users set passwordHash = ?, email_reset_code=null, WHERE email= ? AND  email_reset_code = ?", [hashedPassword, cleanedEmail, code])
    if (result.affectedRows > 0) {
      res.send(result)
    } else {
      res.status(400).send("Invalid code")
    }
  } catch (error) {
    res.send(error)
  }
})
router.delete('/token', auth, async (req: Request & IUser, res) => {
  const { id: uuid } = req.user!;
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: "Expo push token required" });
    return
  }

  try {
    const [result] = await db.query(
      "DELETE FROM user_push_tokens WHERE uuid=? AND token=?",
      [uuid, token]
    );
    if (result.affectedRows > 0) {
      res.send(result)
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove push token" });
  }
})
router.get("/banks", auth, async (req: Request & IUser, res) => {
  const { id: userId } = req.user!;
  try {
    const [rows] = await db.query("SELECT * FROM user_bank WHERE user_id = ?", [userId]);
    res.send(rows);
  } catch (error) {
    res.send(error)
  }

});
router.post("/bank", auth, async (req: Request & IUser, res) => {
  const { id: userId } = req.user!;
  const { bank_code, account_number, name } = req.body;
  const bank_name = SA_BANKS.filter((bank => bank.code == bank_code))
  const bankName = bank_name[0].name
  const bankCode = bank_name[0].code
  try {
    // 1. Create real Paystack Transfer Recipient
    const paystackRecipient = await createTransferRecipient(name, account_number, bank_code);
    const recipient_code = paystackRecipient.data.recipient_code; // e.g. RCP_xxx
    
    const uuid = uuidv4();
    const [result] = await db.query(
      "INSERT INTO user_bank (uuid,user_id, bank_name, account_number, recipient_code, bank_code) VALUES (?, ?, ?, ?, ?, ?)",
      [uuid, userId, bankName, account_number, recipient_code, bankCode]
    );

    res.send(result);
  } catch (err: any) {
    console.error(err.response?.data || err.message);
    res.status(400).send({ error: "Failed to add bank account" });
  }
});
router.get("/verify", async (req: Request, res) => {
  const { bank_code, account_number } = req.query;
  console.log(bank_code, account_number)
  if (!bank_code || !account_number) {
    res.status(400).send({ error: "Missing bank_code or account_number" });
    return
  }

  try {
    const response = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}&currency=ZAR&enabled_for_verification=true`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    if (!response.data.status) {
      res.status(400).send({ error: "Unable to verify account" });
      return
    }

    const { account_name, account_number: accNum } = response.data.data;
    res.send({ account_name, account_number: accNum });
  } catch (err: any) {
    console.error("Paystack verification error:", err.response?.data || err.message);
    res.status(500).send({ error: "Failed to verify bank account" });
  }
});
router.get("/banklist", async (_req, res) => {
  res.json(SA_BANKS);
});
router.post("/banklist", async (_req, res) => {

})
router.delete("/", auth, async (req: Request & IUser, res) => {
  const { id: userId } = req.user!;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();
    const [disputes] = await conn.query(
      `SELECT 1
       FROM dispute d
       JOIN transactions t ON d.trans_id = t.transactions_id
       JOIN buyer_request b ON t.buy_id= b.buy_id
       WHERE (t.seller_id = ? OR b.buyer_id = ?) AND d.mark_as = 'pending'
       LIMIT 1`,
      [userId, userId]
    );

    if (disputes.length > 0) {
      await conn.rollback();
      console.log('could not delete data : dispute ')
      res.status(409).json({
        message:
          "Account cannot be deleted because there is an active dispute. Please resolve it first.",
      });
      return
    }

    await conn.query(
      `INSERT INTO phone_numbers_trash
       SELECT *, NOW(), ? FROM phone_numbers WHERE uuid = ?`,
      [userId, userId]
    );
    await conn.query(
      `INSERT INTO buyer_request_trash
       SELECT *, NOW(), ? FROM buyer_request WHERE buyer_id = ?`,
      [userId, userId]
    );
    await conn.query(
      `INSERT INTO transactions_trash
       SELECT *, NOW(), ? FROM transactions WHERE seller_id = ?`,
      [userId, userId]
    );

    await conn.query(
      `INSERT INTO users_trash
       SELECT *, NOW(), ? FROM users WHERE uuid = ?`,
      [userId, userId]
    );
    await conn.query(`DELETE FROM transactions WHERE seller_id = ?`, [userId]);
    await conn.query(`DELETE FROM buyer_request WHERE buyer_id = ?`, [userId]);

    await conn.query(`DELETE FROM user_push_tokens WHERE uuid = ?`, [userId]);
    await conn.query(`DELETE FROM phone_numbers WHERE uuid = ?`, [userId]);
    await conn.query(`DELETE FROM users WHERE uuid = ?`, [userId]);
    await conn.commit();

    res.json({ message: "Account deleted successfully" });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Delete failed" });
  } finally {
    conn.release();
  }
});

export default router