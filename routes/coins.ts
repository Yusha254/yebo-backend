import { Request, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/db";
import { validateWithdrawals } from "../config/validators";
import auth, { IUser } from "../middleware/auth";


const router=Router();

router.get("/trans", auth, async (req: Request & IUser, res) => {
    const { id: uuid } = req.user!;
    const { page = 1, limit = 10 } = req.query;
  
    try {
      const offset = (Number(page) - 1) * Number(limit);
      const [transactions] = await db.query(
        `SELECT * FROM yebo_coins
         WHERE user_uuid = ? 
         ORDER BY transaction_timestamp DESC 
         LIMIT ? OFFSET ?`,
        [uuid, Number(limit), offset]
      );
      const [[{ total }]] = await db.query(
        `SELECT COUNT(*) AS total 
         FROM yebo_coins
         WHERE user_uuid = ?`,
        [uuid]
      );
  
      res.json({
        transactions,
        hasMore: offset + transactions.length < total,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });
  router.post("/withdraw",auth,async(req: Request & IUser, res)=>{
    const { id: uuid } = req.user!;
    const validate=validateWithdrawals.safeParse(req.body);
    if(!validate.success)  {
      console.log(validate.error.message)
        res.status(400).send(validate.error.message)
        return
    }
    const {amount,reference_code}=req.body;
    const coin_id=uuidv4()
    const connection = await db.getConnection();
    try {
        
        const [rows]=await db.query("SELECT * FROM users where uuid=?",[uuid])
      if(rows.length<1){
        res.status(404).send("user doesn't exist ")
        return
      }
      const user= rows[0]
      if(user.yeboCoins<amount){
        res.status(400).send('Amount not sufficient')
        return
      }
      await connection.beginTransaction();
        const [results]=await connection.query("INSERT INTO yebo_coins (user_uuid,coins_uuid,amount,action,status,reference_code)VALUES(?,?,?,?,?,?)",[uuid,coin_id,amount,"withdrawal","pending",reference_code])
        if(results.affectedRows>0){
            const new_balance=user.yeboCoins-amount
            const [results]=await connection.query("UPDATE users SET yeboCoins =? WHERE uuid=?",[new_balance,uuid]);
            await connection.commit()
            res.send(results)
        }
    } catch (error) {
      console.log(error)
        await connection.rollback()
        res.send(error)
    }finally{
        connection.release()
    }
  })
export default router;