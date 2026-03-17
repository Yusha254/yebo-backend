import bcrypt from 'bcrypt';
import { Request, Response, Router } from "express";
import jwt from 'jsonwebtoken';
import db from "../config/db";
import cleanEmail from "../config/utils";
import { adminRegisterSchema, statusChangeSchema, validateLogin } from "../config/validators";
import admin from "../middleware/admin";
import { IUser } from "../middleware/auth";
import { v4 as uuidv4 } from "uuid";
import { initiateTransfer, refundTransaction } from "../utils/paystack";
const allowedTransitions: Record<string, string[]> = {
  pending: ["processing", "failed", "success"],
  processing: ["success", "failed"],
  success: [],   
  failed: []  
};

const router=Router()

router.post("/login", async (req, res) => {
    const validation = validateLogin.safeParse(req.body);
    if (!validation.success) {
       res.status(400).send(validation.error.message);
       return;
    }
    const { email, password } = req.body;
    const cleanedEmail = cleanEmail(email);
  
    try {
      const [rows]: any = await db.query('SELECT * FROM admin WHERE email = ? ', [cleanedEmail]);
      if (rows.length === 0) {
        res.status(400).json({ error: "Invalid email or password" });
        return
      }
  
      const user = rows[0];

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        res.status(400).json({ error: "Invalid email or password" });
        return 
      }
      console.log(user)
      const token = jwt.sign(
        { id: user.uuid, email: user.email},
        process.env.JWT_SECRET as string,
        { expiresIn: '7d' }
      );
  
      delete user.password;
      res.header("x-auth-admin",token).json({success:true,user})
    } catch (error) {
      console.log(error)
      res.status(500).send("Server error");
      return 
    }
  });
  router.get("/stats", [admin], async (req: Request & IUser, res: Response) => {
    try {
      const [result] = await db.query(`SELECT
        (SELECT COUNT(*) FROM transactions) AS total_transactions,
        (SELECT SUM(amount) FROM buyer_request) AS total_revenue,
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COALESCE(SUM(amount), 0) FROM profits) AS total_profits,
        (SELECT COALESCE(SUM(yeboCoins), 0) FROM users) AS total_circulating_coins;`);
      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error getting stats");
    }
  });

  router.get("/status",[admin],async(_req:Request,res:Response)=>{

    try {
      const [results]=await db.query(`
        SELECT
          COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count,
          COUNT(CASE WHEN status = 'processing' THEN 1 END) AS processing_count,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) AS complete_count,
          COUNT(CASE WHEN status = 'dispute' THEN 1 END) AS dispute_count
        FROM buyer_request;
        `)
        res.send(results)
    } catch (error) {
      res.send(error)
    }
  })
  router.get("/latest_trans",[admin],async(_req:Request,res:Response)=>{
    try {
      const [results]=await db.query(`SELECT *
          FROM buyer_request
          ORDER BY request_time
          LIMIT 6;`)
          res.send(results)
    } catch (error) {
      res.send(error)
    }
  })
  router.get("/dispute", admin, async (req: Request & IUser, res) => {
    const { page = 1, limit = 10 } = req.query;

    try {
      const offset = (Number(page) - 1) * Number(limit);
      const [dispute] = await db.query(
        `SELECT 
          buyer_request.amount,
          buyer_request.phone_number AS buyer_number,
          buyer_request.request_time,
          transactions.seller_phone,
          transactions.seller_id,
          phone_numbers.network,
          dispute.sender_url,
          dispute.buyer_url,
          dispute.dispute_id,
          isps.name as network_name
        FROM buyer_request
        JOIN transactions 
          ON buyer_request.buy_id = transactions.buy_id
        JOIN phone_numbers
          ON buyer_request.phone_number=phone_numbers.phone_number
        JOIN dispute
          ON transactions.transactions_id=dispute.trans_id
        JOIN isps 
          ON phone_numbers.network=isps.network_id
        WHERE transactions.transaction_status = 'dispute'
        ORDER BY buyer_request.request_time DESC
        LIMIT ? OFFSET ?;`,
        [ Number(limit), offset]
      );
      const [[{ total }]] = await db.query(
        `SELECT COUNT(*) FROM buyer_request JOIN transactions ON buyer_request.buy_id=transactions.buy_id
         WHERE transactions.transaction_status='dispute'
         ORDER BY request_time DESC`
      );
      res.json({
        dispute,
        hasMore: offset + dispute.length < total,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });
  router.get("/dispute/:id",admin,(async(req,res)=>{
    const {id}=req.params;
    try {
    const [result]=await db.query(`SELECT 
          buyer_request.amount,
          buyer_request.phone_number AS buyer_number,
          buyer_request.request_time,
          transactions.seller_phone,
          transactions.seller_id,
          phone_numbers.network,
          dispute.sender_url,
          dispute.buyer_url,
          dispute.dispute_id,
          isps.name as network_name
        FROM buyer_request
        JOIN transactions 
          ON buyer_request.buy_id = transactions.buy_id
        JOIN phone_numbers
          ON buyer_request.phone_number=phone_numbers.phone_number
        JOIN dispute
          ON transactions.transactions_id=dispute.trans_id
        JOIN isps 
          ON phone_numbers.network=isps.network_id
        WHERE transactions.transaction_status = 'dispute'
        AND dispute.dispute_id= ?
        ORDER BY buyer_request.request_time DESC`,[id])
      res.send(result[0])
    } catch (error) {
      res.send(error)
    }
  }))
 

router.put("/solve_dispute/:id", admin, async (req, res) => {
  const { id } = req.params;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction(); 
    const [result] = await conn.query(
      `
      SELECT 
        t.seller_phone,
        t.seller_id,
        t.transactions_id,
        b.amount,
        b.phone_number,
        b.buy_id
      FROM dispute
      JOIN transactions t
        ON dispute.trans_id = t.transactions_id
      JOIN buyer_request b
        ON b.buy_id = t.buy_id
      WHERE dispute.dispute_id = ?
      `,
      [id]
    );

    if (result.length === 0) {
       res.status(404).json({ message: "Dispute not found" });
       return
    }

    const disputeResp = result[0];
    const { seller_id, seller_phone, amount, buy_id: buyId, transactions_id: trans_id } = disputeResp;

    const yebocoins = Math.floor(amount * 0.75);
    const deducts = Math.floor(amount * 0.25);

    const [user] = await conn.query(`SELECT yeboCoins FROM users WHERE uuid = ?`, [seller_id]);
    const [phone_row] = await conn.query(`SELECT airtime FROM phone_numbers WHERE phone_number = ?`, [seller_phone]);

    const total_coins = yebocoins + user[0].yeboCoins;
    const new_airtime = phone_row[0].airtime - amount;

    const coin_id = uuidv4();
    const [updateDispute] = await conn.query(`UPDATE dispute SET mark_as = ? WHERE dispute_id = ?`, ["success", id]);

    if (updateDispute.affectedRows > 0) {
      await conn.query("UPDATE buyer_request SET status = 'completed' WHERE buy_id = ?", [buyId]);
      await conn.query("UPDATE transactions SET transaction_status = 'success' WHERE transactions_id = ?", [trans_id]);
      await conn.query("UPDATE users SET yeboCoins = ? WHERE uuid = ?", [total_coins, seller_id]);
      await conn.query("UPDATE phone_numbers SET airtime = ? WHERE phone_number = ?", [new_airtime, seller_phone]);

      // insert records
      await conn.query(
        "INSERT INTO yebo_coins (user_uuid, coins_uuid, amount, phone_ref, action) VALUES (?, ?, ?, ?, ?)",
        [seller_id, coin_id, yebocoins, seller_phone, "topup"]
      );

      await conn.query(
        "INSERT INTO profits (uuid, transaction_uuid, amount) VALUES (?, ?, ?)",
        [seller_id, trans_id, deducts]
      );
    }

    await conn.commit(); // commit all changes
    res.json({ message: "Dispute resolved successfully" });

  } catch (error) {
    await conn.rollback(); // rollback on error
    console.error(error);
    res.status(500).json({ message: "Transaction failed" });
  } finally {
    conn.release();
  }
});
router.put("/failed_dispute/:id",admin,async(req,res)=>{
   const { id } = req.params;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction(); 
    const [result] = await conn.query(
      `
      SELECT 
        t.seller_phone,
        t.seller_id,
        t.transactions_id,
        b.amount,
        b.phone_number,
        b.buy_id
      FROM dispute
      JOIN transactions t
        ON dispute.trans_id = t.transactions_id
      JOIN buyer_request b
        ON b.buy_id = t.buy_id
      WHERE dispute.dispute_id = ?
      `,
      [id]
    );

    if (result.length === 0) {
       res.status(404).json({ message: "Dispute not found" });
       return
    }

    const disputeResp = result[0];
    const {  buy_id: buyId, transactions_id: trans_id } = disputeResp;


    
    const [updateDispute] = await conn.query(`UPDATE dispute SET mark_as = ? WHERE dispute_id = ?`, ["revoked", id]);
    if (updateDispute.affectedRows > 0) {
      await conn.query("UPDATE buyer_request SET status = 'pending' WHERE buy_id = ?", [buyId]);
      await conn.query("UPDATE transactions SET transaction_status = 'failed' WHERE transactions_id = ?", [trans_id]);
    }
    await conn.commit(); // commit all changes
    res.json({ message: "Dispute resolved successfully" });

  } catch (error) {
    await conn.rollback(); // rollback on error
    console.error(error);
    res.status(500).json({ message: "Transaction failed" });
  } finally {
    conn.release();
  }
})
  router.get("/transactions",[admin],async(req:Request,res:Response)=>{
    const { page = 1, limit = 10 } = req.query;
    try {
      const offset = (Number(page) - 1) * Number(limit);
      const [result]=await db.query(`
        SELECT 
          buyer_request.amount,
          buyer_request.phone_number,
          transactions.seller_phone,
          transactions.transaction_status,
          transactions.transactions_id,
          isps.name as network_name
        FROM  buyer_request
        LEFT JOIN  transactions
          ON buyer_request.buy_id=transactions.buy_id
        JOIN phone_numbers
          ON phone_numbers.phone_number=buyer_request.phone_number
        JOIN isps
          ON isps.network_id=phone_numbers.network
        ORDER BY buyer_request.request_time DESC
        LIMIT ? OFFSET ?;
        `,[ Number(limit), offset])
        const [[{ total }]] = await db.query(
          `SELECT COUNT(*)
           FROM transactions 
           JOIN buyer_request 
              ON buyer_request.buy_id=transactions.buy_id;`,
        );
        res.json({result,hasMore:offset+result.length<total})
    } catch (error) {
      res.send(error)
    }
  })
 router.get("/users", admin, async (req, res) => {
  const { page = 1, limit = 10, search = "" } = req.query;

  try {
    const offset = (Number(page) - 1) * Number(limit);

    let searchQuery = "";
    let params = [];

    if (search) {
      searchQuery = `
        WHERE 
          users.fullname LIKE ? 
          OR users.email LIKE ?
          OR EXISTS (
            SELECT 1 FROM phone_numbers pn
            WHERE pn.uuid = users.uuid
            AND pn.phone_number LIKE ?
          )
      `;
      const searchValue = `%${search}%`;
      params.push(searchValue, searchValue, searchValue);
    }
    const [result] = await db.query(
      `
      SELECT 
        users.fullname,
        users.uuid,
        users.yeboCoins,
        users.isEmailVerified,
        COUNT(phone_numbers.phone_number) AS total_numbers
      FROM users
      LEFT JOIN phone_numbers
        ON users.uuid = phone_numbers.uuid
      ${searchQuery}
      GROUP BY users.uuid
      ORDER BY users.createdAt DESC
      LIMIT ? OFFSET ?
      `,
      [...params, Number(limit), offset]
    );

    
    let countQuery = `
      SELECT COUNT(*) as total
      FROM users
      ${searchQuery}
    `;
    const totalUsersQuery= `
      SELECT COUNT(*) as totalUsers
      FROM users`
    const [[{ total }]] = await db.query(countQuery, params);
    const [[{totalUsers}]] =await db.query(totalUsersQuery)
    const totalPages = Math.ceil(total / Number(limit));
    console.log(totalUsers)
    res.json({
      result,
      hasMore: offset + result.length < total,
      totalPages,
      currentPage: Number(page),
      totalCount: total,
      totalUsers
    });

  } catch (error) {
    res.send(error);
  }
});
  router.get("/user/:uuid",admin,async(req,res)=>{
    const {uuid}=req.params;

    try {
      const [result] =  await db.query(`
        SELECT 
          users.fullname,
          users.email,
          users.createdAt,
          users.isBlocked,
          p.network,
          p.phone_number,
          p.is_verified,
          p.airtime,
          i.name as network_name
        FROM  users
        JOIN  phone_numbers p
          ON users.uuid=p.uuid
        JOIN isps i
          ON p.network=i.network_id
        WHERE users.uuid= ?`,[uuid])
        res.send(result)
    } catch (error) {
      res.send(error)
    }
  })
  router.get("/phone/:phone",admin,async(req,res)=>{
    const {phone}=req.params;
    try {
      const [result] = await db.query(`
        SELECT 
        b.buy_id,
        b.phone_number,
        t.seller_phone,
        b.amount,
        CASE
          WHEN t.seller_phone = ? THEN 'seller'
          WHEN b.phone_number = ? THEN 'buyer'
          END AS role
        FROM buyer_request b
        LEFT JOIN transactions t ON b.buy_id = t.buy_id
        WHERE t.seller_phone = ? OR b.phone_number = ?
        `,[phone,phone,phone,phone])
        res.send(result)
    } catch (error) {
      res.send(error)
    }
  })
  router.get("/payments/stats",admin,async(_req,res)=>{
    try {
      const [results]=await db.query(`
        SELECT
          COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count,
          COUNT(CASE WHEN status = 'processing' THEN 1 END) AS processing_count,
          COUNT(CASE WHEN status = 'success' AND action = 'withdrawal' THEN 1 END) AS complete_count,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed_count
        FROM yebo_coins;
        `)
        res.send(results)
    } catch (error) {
      res.send(error)
    }
  })
  router.get("/payments/list", admin, async (req, res) => {
    const { page = 1, limit = 10, status, bank, action = "withdrawal" } = req.query;

    try {
      const offset = (Number(page) - 1) * Number(limit);

      let whereClause = `WHERE yebo_coins.action = ?`;
      const params: any[] = [action];

      if (status) {
        whereClause += ` AND yebo_coins.status = ?`;
        params.push(status);
      }
      if (bank && action === "withdrawal") {
        whereClause += ` AND user_bank.bank_code = ?`;
        params.push(bank);
      }

      const [result] = await db.query(
        `
        SELECT
          users.fullname,
          users.uuid,
          yebo_coins.amount,
          yebo_coins.status,
          yebo_coins.transaction_timestamp,
          yebo_coins.reference_code,
          yebo_coins.phone_ref,
          yebo_coins.action,
          user_bank.bank_code
        FROM yebo_coins
        JOIN users ON users.uuid = yebo_coins.user_uuid
        LEFT JOIN user_bank ON user_bank.recipient_code = yebo_coins.reference_code
        ${whereClause}
        ORDER BY yebo_coins.transaction_timestamp DESC
        LIMIT ? OFFSET ?
        `,
        [...params, Number(limit), offset]
      );
      const [[{ total }]] = await db.query(
        `
        SELECT COUNT(*) AS total
        FROM yebo_coins
        ${whereClause}
        `,
        params
      );

      res.json({
        result,
        hasMore: offset + result.length < total,
      });
    } catch (error) {
      console.error("Error fetching payments:", error);
      res.status(500).json({ message: "Server error", error });
    }
  });
   router.get("/payments/pending",admin,async(req,res)=>{
    try {
      const [result] = await db.query(
        `SELECT
          users.fullname,
          users.uuid,
          yebo_coins.amount,
          yebo_coins.status,
          yebo_coins.transaction_timestamp,
          yebo_coins.reference_code,
          yebo_coins.phone_ref,
          yebo_coins.action
        FROM yebo_coins
        JOIN users ON users.uuid = yebo_coins.user_uuid
        WHERE yebo_coins.action = 'withdrawal' AND yebo_coins.status = 'pending'
        ORDER BY yebo_coins.transaction_timestamp DESC
        LIMIT 10`
      );
      res.send(result)
    } catch (error) {
      res.send(error)
    }
  })
  router.get("/payments/:id",admin,async(req,res)=>{
    const {id}=req.params;
    try {
     const [result]=await db.query(`
      SELECT 
        y.coins_uuid,
        y.amount,
        y.status,
        y.user_uuid,
        b.bank_name,
        b.account_number,
        u.fullname
      FROM yebo_coins as y
      JOIN user_bank as b
        ON b.recipient_code=y.reference_code
      JOIN users as u
        ON b.user_id=u.uuid
      WHERE b.recipient_code = ?
      `,[id])
      res.send(result[0])
      } catch (error) {
      res.send(error)
    }

  })
  router.get("/payments/pending",admin,async(req,res)=>{
    try {
      const [result] = await db.query(
        `SELECT
          users.fullname,
          users.uuid,
          yebo_coins.amount,
          yebo_coins.status,
          yebo_coins.transaction_timestamp,
          yebo_coins.reference_code,
          yebo_coins.phone_ref,
          yebo_coins.action
        FROM yebo_coins
        JOIN users ON users.uuid = yebo_coins.user_uuid
        WHERE yebo_coins.action = 'withdrawal' AND yebo_coins.status = 'pending'
        ORDER BY yebo_coins.transaction_timestamp DESC
        LIMIT 10`
      );
      res.send(result)
    } catch (error) {
      res.send(error)
    }
  })
  router.put("/payments/:id",admin,async(req,res):Promise<void>=>{
    const {id} = req.params;
    const validator=statusChangeSchema.safeParse(req.body)
    if(!validator.success){
      res.send(validator.error.message).status(400)
      return
    }
    const { action } = validator.data;

  try {
    const [rows]: any = await db.query("SELECT status FROM yebo_coins WHERE reference_code = ?", [id]);
    if (rows.length === 0) { 
      res.status(404).json({ error: "Payment not found" });
      return
}
    const currentStatus = rows[0].status;

    if (!allowedTransitions[currentStatus]?.includes(action)) {
      res.status(400).json({
        error: `Invalid transition: ${currentStatus} → ${action}`
      });
       return;
    }

    await db.query("UPDATE yebo_coins SET status = ? WHERE reference_code = ?", [action, id]);

     res.json({ message: `Payment updated ${currentStatus} -> ${action}` }); 

  } catch (err) {
    console.error(err);
     res.status(500).json({ error: "Server error" });
     return
  }
});

router.get("/profits", admin, async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  try {
    const offset = (Number(page) - 1) * Number(limit);
    const [rows] = await db.query(
      `SELECT 
         p.id, p.amount, p.created_at, p.transaction_uuid,
         u.fullname as seller_name
       FROM profits p
       JOIN users u ON u.uuid = p.uuid
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [Number(limit), offset]
    );
    const [[{ total }]] = await db.query("SELECT COUNT(*) as total FROM profits");
    res.json({ rows, hasMore: offset + rows.length < total });
  } catch (error) {
    console.error("Error fetching profits:", error);
    res.status(500).json({ error: "Server error" });
  }
});
router.post("/register",async(req,res)=>{
  const validation = adminRegisterSchema.safeParse(req.body);
    if (!validation.success) {
       res.status(400).send(validation.error.message);
       return;
    }
    const { email, password,firstname,lastname,code } = req.body;
    const cleanedEmail = cleanEmail(email);
    const uuid = uuidv4();
    try {
      const dbCode=process.env.CODE
      if(dbCode!==code){
        res.status(401).send('authorization code not valid')
        return
      }
    const [email_exists]= await db.query(`SELECT 1 FROM admin WHERE email = ?`,[cleanedEmail])
    if(email_exists.length>0){
      res.send('user already registered').status(400)
      return
    }
    const encryptedPassword=await bcrypt.hash(password,10)
    const [result]=await db.query("INSERT INTO admin (uuid,email,firstname,lastname,password) VALUES(?,?,?,?,?)",[uuid,cleanedEmail,firstname,lastname,encryptedPassword]);
    if(result.affectedRows>0){
      res.status(201).json({ message: 'User successfully registered.' });
    }
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Server error' });  
    }
})

// ── Marketplace admin routes ────────────────────────────────────────────────

// GET /admin/marketplace/escrows — list all escrow transactions with status filter
router.get("/marketplace/escrows", admin, async (req, res: any) => {
  const { status, page = 1, limit = 15 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    let where = "";
    const params: any[] = [];
    if (status) {
      where = "WHERE et.status = ?";
      params.push(status);
    }
    const [rows] = await db.query(
      `SELECT
         et.escrow_id, et.status, et.amount_held, et.payment_ref,
         et.buyer_confirmed, et.seller_confirmed, et.created_at,
         mo.airtime_amount, mo.seller_phone, mo.asking_price,
         isps.name AS network_name,
         buyer.fullname AS buyer_name,
         seller.fullname AS seller_name
       FROM escrow_transactions et
       JOIN marketplace_offers mo ON mo.offer_id = et.offer_id
       JOIN isps ON mo.network_id = isps.network_id
       JOIN users buyer ON buyer.uuid = et.buyer_id
       JOIN users seller ON seller.uuid = et.seller_id
       ${where}
       ORDER BY et.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );
    const countResult: any = await db.query(
      `SELECT COUNT(*) AS total FROM escrow_transactions et ${where}`,
      params
    );
    const total = countResult[0][0].total;
    res.json({ rows, hasMore: offset + rows.length < total });
  } catch (error) {
    console.error("Admin escrows error:", error);
    res.status(500).json({ error: "Failed to fetch escrows" });
  }
});

// GET /admin/marketplace/escrows/:escrow_id — single escrow detail
router.get("/marketplace/escrows/:escrow_id", admin, async (req, res: any) => {
  const { escrow_id } = req.params;
  try {
    const [rows]: any = await db.query(
      `SELECT
         et.*, mo.airtime_amount, mo.seller_phone, mo.asking_price,
         isps.name AS network_name,
         buyer.fullname AS buyer_name, buyer.email AS buyer_email,
         seller.fullname AS seller_name, seller.email AS seller_email
       FROM escrow_transactions et
       JOIN marketplace_offers mo ON mo.offer_id = et.offer_id
       JOIN isps ON mo.network_id = isps.network_id
       JOIN users buyer ON buyer.uuid = et.buyer_id
       JOIN users seller ON seller.uuid = et.seller_id
       WHERE et.escrow_id = ?`,
      [escrow_id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Escrow not found" });
      return;
    }
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch escrow" });
  }
});

// PUT /admin/marketplace/escrows/:escrow_id/resolve — admin resolves a disputed escrow
router.put("/marketplace/escrows/:escrow_id/resolve", admin, async (req, res: any) => {
  const { escrow_id } = req.params;
  const { action } = req.body; // "release" or "refund"
  if (!["release", "refund"].includes(action)) {
    res.status(400).json({ error: "action must be 'release' or 'refund'" });
    return;
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows]: any = await conn.query(
      "SELECT * FROM escrow_transactions WHERE escrow_id = ?",
      [escrow_id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      res.status(404).json({ error: "Escrow not found" });
      return;
    }
    if (!["held", "dispute"].includes(rows[0].status)) {
      await conn.rollback();
      res.status(400).json({ error: "Escrow is not in a resolvable state" });
      return;
    }
    const newStatus = action === "release" ? "released" : "refunded";
    await conn.query(
      "UPDATE escrow_transactions SET status = ? WHERE escrow_id = ?",
      [newStatus, escrow_id]
    );
    await conn.query(
      "UPDATE marketplace_offers SET status = ? WHERE offer_id = ?",
      [action === "release" ? "completed" : "active", rows[0].offer_id]
    );
    await conn.commit();
    
    // --- YEBO COINS PAYOUT / REFUND LOGIC ---
    try {
      if (action === "release") {
        const amount_held = rows[0].amount_held;
        const payout = Math.floor(amount_held * 0.75);
        const fee = Math.floor(amount_held * 0.25);

        await db.query(
          "UPDATE users SET yeboCoins = yeboCoins + ? WHERE uuid = ?",
          [payout, rows[0].seller_id]
        );
        await db.query(
          "INSERT INTO profits (uuid, transaction_uuid, amount) VALUES (?, ?, ?)",
          [rows[0].seller_id, escrow_id, fee]
        );
      } else if (action === "refund") {
        await db.query(
          "UPDATE users SET yeboCoins = yeboCoins + ? WHERE uuid = ?",
          [rows[0].amount_held, rows[0].buyer_id]
        );
      }
    } catch (dbError) {
      console.error("Yebo Coins processing error in admin resolve:", dbError);
      // We don't fail the whole request because the DB status is already updated,
      // but we log it for manual intervention.
    }

    res.json({ success: true, newStatus });
  } catch (error) {
    await conn.rollback();
    console.error("Admin resolve error:", error);
    res.status(500).json({ error: "Failed to resolve escrow" });
  } finally {
    conn.release();
  }
});

  export default router;