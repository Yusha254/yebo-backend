import { Request, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/db";
import { sendPushNotification } from "../config/sendNotifications";
import { validateBookTrans, validateBuyerRequest, validateDisputeParams } from "../config/validators";
import auth, { IUser } from "../middleware/auth";
import { generateTransactionId } from "../config/transactionCodeGen";
const router=Router();
interface IBuyer{
    amount:number,
    phone:string,
    payment_id:string
}
router.post("/buy",auth,async(req:Request&IUser,res)=>{
    const validate=validateBuyerRequest.safeParse(req.body);
    if(!validate.success)  {
        console.log('error here')
        res.status(400).send(validate.error.message)
        return
    }
    const {id:uuid}=req.user!;
    const buy_id=uuidv4()
    const {amount,phone,payment_id} =req.body as IBuyer;
    const conn=await db.getConnection();
    try {
        await conn.beginTransaction();
        const [result]=await conn.query("INSERT INTO buyer_request (buy_id,buyer_id,phone_number,amount,payment_id) values(?,?,?,?,?)",[buy_id,uuid,phone,amount,payment_id])
        if(result.affectedRows>0){
            res.send(result)
        }
        else{
            res.send('something went wrong') 
        }
        await conn.commit()
    } catch (error) {
        await conn.rollback();
        console.log(error)
        res.send(error)
    } finally{
        conn.release()
    }
})
router.get("/sell_list/:phone",auth,async(req:Request&IUser,res)=>{
    const {phone}=req.params;
    const {id}=req.user!
    try {
        const [rows]=await db.query("SELECT * FROM phone_numbers WHERE phone_number=?",[phone])
        if(rows.length==0){
            res.status(400).send('phone number not found' )
            return
        }
        const phone_data=rows[0];
        if(id!==phone_data.uuid){
            res.status(403).send("uuids do not match")
            return 
        }
        const {airtime,network}=phone_data
        const [result]=await db.query(
            `SELECT 
                phone_numbers.network,
                isps.name AS network_name,
                phone_numbers.phone_number as buyer_phone,
                buyer_request.amount, 
                buyer_request.buy_id 
            FROM buyer_request 
            JOIN phone_numbers 
                ON phone_numbers.phone_number=buyer_request.phone_number 
            JOIN isps  ON phone_numbers.network = isps.network_id 
            WHERE phone_numbers.network = ? AND buyer_request.amount <= ? AND buyer_request.status= 'pending'`,[network,airtime]) 
        res.send(result)
    } catch (error) {
        console.log(error)
        res.send(error)
    }
})
router.post("/sell", auth, async (req: Request & IUser, res) => {
  const { id: uuid } = req.user!;

  const validate = validateBookTrans.safeParse(req.body);
  if (!validate.success) {
    res.status(400).send(validate.error.message);
     return
  }

  const { buy_id, seller_phone } = req.body;
  const transact_id = uuidv4();
  try {
    const [buyRows]: any = await db.query(`SELECT * FROM transactions WHERE buy_id = ?`, [buy_id]);
    if (buyRows.length > 0) {
       res.status(400).send("This buy request has already been booked");
       return
    }
  } catch (error) {
    
  }
  const conn = await db.getConnection();

  let attempts = 0;
  let network: "Telkom" | "Mtn" | "Vodacom";

  try {
    const [rows]: any = await conn.query(
      "SELECT isps.name as network FROM phone_numbers JOIN isps  ON phone_numbers.network = isps.network_id  WHERE phone_number = ?",
      [seller_phone]
    );
    console.log(rows)
    if (rows.length === 0) {
       res.status(400).send("Phone number not found");
       return
    }

    network = rows[0].network;

    while (attempts < 5) {
      attempts++;

      try {
        const transactionId = generateTransactionId(network);

        await conn.beginTransaction();

        await conn.query(
          `INSERT INTO transactions 
           (transactions_id, buy_id, seller_id, seller_phone, transactionId) 
           VALUES (?, ?, ?, ?, ?)`,
          [transact_id, buy_id, uuid, seller_phone, transactionId]
        );

        await conn.query(
          "UPDATE buyer_request SET status = 'processing' WHERE buy_id = ?",
          [buy_id]
        );

        await conn.commit();

        const [pushRows]: any = await db.query(
          `SELECT user_push_tokens.token 
           FROM buyer_request 
           JOIN user_push_tokens 
             ON buyer_request.buyer_id = user_push_tokens.uuid 
           WHERE buy_id = ?`,
          [buy_id]
        );

        const tokens = pushRows.map((r: any) => r.token);

        if (tokens.length > 0) {
          await sendPushNotification(
            tokens,
            "Your airtime is being processed",
            "You'll receive airtime from " + seller_phone,
            "messages",
            [{ identifier: "view", buttonTitle: "View" }]
          );
        }

         res.send({
          success: true,
          transactionId,
        });
        return

      } catch (error: any) {
        await conn.rollback();

        if (error.code === "ER_DUP_ENTRY") {
          continue; 
        }

        throw error; 
      }
    }

     res.status(500).send("Failed to generate unique transaction ID");
     return

  } catch (error: any) {
    console.log(error);
     res.status(500).send(error.message);
     return
  } finally {
    conn.release();
  }
});
router.get("/get_sellers",auth,async(req:Request&IUser,res)=>{
    const {id:uuid}=req.user!
    try {
        const [rows]=await db.query("SELECT  buyer_request.amount, buyer_request.phone_number, buyer_request.request_time, buyer_request.status,transactions.transactions_id, transactions.booked_at, phone_numbers.network, isps.name AS network_name FROM transactions  JOIN buyer_request ON buyer_request.buy_id = transactions.buy_id JOIN phone_numbers  ON buyer_request.phone_number = phone_numbers.phone_number JOIN isps  ON phone_numbers.network = isps.network_id LEFT JOIN dispute  ON transactions.transactions_id = dispute.trans_id WHERE  transactions.seller_id = ? AND (transactions.seller_marked_success = false OR ( transactions.seller_marked_success = true AND buyer_request.status = 'dispute' AND dispute.sender_url IS NULL)) AND transactions.transaction_status != 'failed'AND (buyer_request.status = 'processing'  OR ( buyer_request.status = 'dispute' AND dispute.sender_url IS NULL)) ORDER BY buyer_request.request_time DESC;",[uuid]);
        res.send(rows)
    } catch (error) {
        console.log(error)
        res.send(error)
    }
})
router.get("/get_buylist",auth,async(req:Request&IUser,res)=>{
    const {id:uuid}=req.user!
    try {
        const [rows]=await db.query("SELECT buyer_request.amount,buyer_request.status, buyer_request.request_time,buyer_request.phone_number,buyer_request.buy_id, transactions.transactions_id,transactions.booked_at,transactions.seller_marked_success,phone_numbers.network,isps.name as network_name,transactions.seller_phone,buyer_request.buyer_id FROM transactions JOIN buyer_request ON buyer_request.buy_id=transactions.buy_id JOIN phone_numbers ON buyer_request.phone_number=phone_numbers.phone_number JOIN isps ON phone_numbers.network=isps.network_id  LEFT JOIN dispute ON transactions.transactions_id=dispute.trans_id WHERE buyer_request.buyer_id=? AND (buyer_request.status = 'processing' OR (buyer_request.status = 'dispute' AND dispute.buyer_url IS NULL))  ORDER BY buyer_request.request_time DESC",[uuid]);
        res.send(rows)
    } catch (error) {
        console.log(error)
        res.send(error)
    }
})
router.put('/seller_mark_complete/:trans_id',auth,async(req:Request&IUser,res)=>{
    const {id:uuid}=req.user!
    const {trans_id}=req.params;
    try {
        const [result]= await db.query("UPDATE transactions SET seller_marked_success= TRUE WHERE transactions_id = ? AND seller_id=?",[trans_id,uuid])
        if(result.affectedRows>0){
            res.send(result)
            const [rows]: any = await db.query(
                `
                SELECT 
                  user_push_tokens.token,
                  buyer_request.amount,
                  transactions.seller_phone,
                  transactions.buy_id 
                FROM transactions 
                JOIN buyer_request 
                  ON buyer_request.buy_id = transactions.buy_id 
                JOIN user_push_tokens 
                  ON buyer_request.buyer_id = user_push_tokens.uuid 
                WHERE transactions.transactions_id = ?
                `,
                [trans_id]
              );
            const tokens = (rows as any[]).map(r => r.token);
            const { amount, seller_phone } = rows[0];
            if (tokens.length > 0) {
                await sendPushNotification(
                tokens,
                "Confirm airtime Transaction",
                `${seller_phone} has sent you airtime ${amount}`,
                "messages",
                [
                 {identifier:"confirm",buttonTitle:"Confirm"},
                 {identifier:"revoke",buttonTitle:"Revoke"}
                ] ,
                );
            }
        }
    } catch (error) {
        res.status(500).send("something went wrong");
    }

})
router.put('/revoke_transaction/:trans_id',auth,async(req:Request&IUser,res)=>{
    const {id:uuid}=req.user!
    const {trans_id}=req.params;

    const conn=await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows]=await conn.query("SELECT buy_id from transactions WHERE  transactions_id = ? AND seller_id = ?",[trans_id,uuid])
        if(rows.length<1){
            res.status(404).send('Buy transaction not found');
            return;
        }
        const buyId=rows[0].buy_id
        
        await conn.query("UPDATE buyer_request SET status = 'pending' WHERE buy_id = ?",[buyId])
        const [result] = await conn.query("DELETE FROM transactions WHERE transactions_id = ?",[trans_id])
        await conn.commit();
        res.send(result)
    } catch (error) {
        await conn.rollback()
        res.status(500).send('transaction failed.')
    }
    finally{
        conn.release()
    }
})
router.put("/confirm_trans_as_buyer/:trans_id",auth,async(req:Request & IUser,res)=>{
    const {id:uuid}=req.user!
    const {trans_id}=req.params;

    const conn=await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows]=await conn.query("SELECT transactions.buy_id , buyer_request.buyer_id,buyer_request.amount,transactions.seller_phone,seller_id  FROM transactions JOIN buyer_request ON buyer_request.buy_id=transactions.buy_id   WHERE  transactions_id = ? AND buyer_request.buyer_id = ?",[trans_id,uuid])
        if(rows.length<1){
            res.status(404).send('Buy transaction not found');
            return;
        }
        const seller_phone_number=rows[0].seller_phone;
        const seller_id= rows[0].seller_id
        const [user]=await conn.query(`SELECT yeboCoins FROM users where uuid = ?`,[seller_id]);
        const [phone_row]=await conn.query(`SELECT airtime from phone_numbers where phone_number = ?`,[seller_phone_number])
        const buyId =rows[0].buy_id 
        const airtime_amount=rows[0].amount
        const yebocoins=Math.floor(airtime_amount*0.75)
        const current_coins=user[0].yeboCoins
        const total_coins=yebocoins+current_coins;
        const current_total=phone_row[0].airtime
        const new_airtime=current_total-airtime_amount;
        const deducts=Math.floor(airtime_amount*0.25)
        const coin_id=uuidv4()
        await conn.query("UPDATE buyer_request SET status= 'completed' WHERE buy_id=?",[buyId])
       const [result]= await conn.query("UPDATE transactions SET transaction_status = 'success' , buyer_marked_success = TRUE WHERE transactions_id=?",[trans_id])
        await conn.query("UPDATE users SET yeboCoins = ? WHERE uuid = ?",[total_coins,seller_id])
        await conn.query("UPDATE phone_numbers SET airtime =? where phone_number = ?",[new_airtime,seller_phone_number])
        await conn.query("INSERT INTO yebo_coins (user_uuid,coins_uuid,amount,phone_ref,action)VALUES(?,?,?,?,?)",[seller_id,coin_id,yebocoins,seller_phone_number,"topup"])
        await conn.query("INSERT INTO profits(uuid,transaction_uuid,amount)VALUES(?,?,?)",[uuid,trans_id,deducts])
        await conn.commit()
        const [rowsNotif]= await db.query(`
            SELECT 
                user_push_tokens.token,
                buyer_request.amount,
                buyer_request.phone_number
            FROM transactions 
            JOIN buyer_request ON buyer_request.buy_id=transactions.buy_id
            JOIN user_push_tokens ON transactions.seller_id = user_push_tokens.uuid 
            WHERE transactions_id=?
            `,[trans_id])
            const tokens = (rowsNotif as any[]).map(r => r.token);
            const { amount, phone_number } = rowsNotif[0];
            if (tokens.length > 0) {
                await sendPushNotification(
                tokens,
                "Transaction complete",
                `${phone_number} has confirmed R. ${amount} transfer.Kindly wait as we process your payments`,
                "transactions",
                [{identifier:"view",buttonTitle:"View"}] ,
                );
            }
        res.send(result)
    } catch (error) {
        await conn.rollback()
        console.log(error)
        res.status(500).send('transaction failed.')
    }
    finally{
        conn.release()
    }
})
router.put("/create_dispute/:trans_id",auth,async(req:Request&IUser,res)=>{
    const {id:uuid}=req.user!
    const {trans_id}=req.params;
    const newId= uuidv4()
    const conn=await db.getConnection()
    try {
        await conn.beginTransaction()
        const [rows]=await conn.query("SELECT transactions.buy_id , buyer_request.buyer_id  FROM transactions JOIN buyer_request ON buyer_request.buy_id=transactions.buy_id   WHERE  transactions_id = ? AND buyer_request.buyer_id = ?",[trans_id,uuid])
        if(rows.length<1){
            res.status(404).send('Buy transaction not found');
            return;
        }
        const buyId =rows[0].buy_id 
        await conn.query("UPDATE buyer_request SET status = 'dispute'  where buy_id=?",[buyId])
        await conn.query("UPDATE transactions SET transaction_status = 'dispute' WHERE  transactions_id = ?",[trans_id])
        const [result]=await conn.query("INSERT INTO dispute (dispute_id,trans_id)VALUES(?,?)",[newId,trans_id])
        await conn.commit()
        const [user]=await db.query(`SELECT phone_number,amount FROM buyer_request where buy_id= ?`,[buyId])
        const [rowsNotif]=await db.query(`
            SELECT 
                user_push_tokens.token,
                buyer_request.amount,
                buyer_request.phone_number
            FROM transactions 
            JOIN buyer_request ON buyer_request.buy_id=transactions.buy_id
            JOIN user_push_tokens ON transactions.seller_id = user_push_tokens.uuid 
            WHERE transactions_id=?`,[trans_id])
            const tokens = (rowsNotif as any[]).map(r => r.token);
            const { amount, phone_number } = user[0];
            if (tokens.length > 0) {
                await sendPushNotification(
                tokens,
                "A Dispute has been created",
                `${phone_number} has disputed R. ${amount} transfer.Further action is needed.`,
                "messages",
                [{identifier:"open",buttonTitle:"Open"}]
                );
            }
        res.send(result)
    } catch (error) {
        await conn.rollback()
        console.log(error)
        res.status(500).send('transaction failed.')
    }finally{
        conn.release()
    }
})
router.get("/get_buy_transactions", auth, async (req: Request & IUser, res) => {
    const { id: uuid } = req.user!;
    const { status } = req.query;
  
    const statuses = ["pending", "completed", "failed", "dispute", "revoked", "cancelled","processing"];
    const isValidStatus = statuses.includes(status as string);
  
    try {
      const [result] = isValidStatus
        ? await db.query("SELECT buyer_request.amount,buyer_request.buy_id,buyer_request.buyer_id, buyer_request.status,buyer_request.request_time,buyer_request.phone_number,transactions.seller_phone,transactions.transactions_id ,isps.name as network_name,transactions.transactions_id,transactions.transactionId, transactions.seller_marked_success, dispute.buyer_url FROM buyer_request LEFT JOIN transactions ON transactions.buy_id=buyer_request.buy_id JOIN phone_numbers ON phone_numbers.phone_number=buyer_request.phone_number JOIN isps ON phone_numbers.network=isps.network_id LEFT JOIN dispute ON transactions.transactions_id = dispute.trans_id WHERE status = ? AND buyer_id = ?", [status, uuid])
        : await db.query("SELECT buyer_request.amount,buyer_request.buy_id,buyer_request.buyer_id, buyer_request.status,buyer_request.request_time,buyer_request.phone_number,transactions.seller_phone,transactions.transactions_id,transactions.transactionId, transactions.seller_marked_success  ,isps.name as network_name,transactions.transactions_id, dispute.buyer_url FROM buyer_request LEFT JOIN transactions ON transactions.buy_id=buyer_request.buy_id JOIN phone_numbers ON phone_numbers.phone_number=buyer_request.phone_number JOIN isps ON phone_numbers.network=isps.network_id LEFT JOIN dispute ON transactions.transactions_id = dispute.trans_id WHERE buyer_id = ?", [uuid]);
  
      res.send(result);
    } catch (error) {
        console.log(error)
      res.status(500).send(error);
    }
  });
  router.get("/get_sell_transactions",auth,async(req: Request & IUser, res) => {
    const { id: uuid } = req.user!;
    const { status } = req.query;
    const statuses = [ "completed", "failed", "dispute", "revoked", "cancelled","processing"];
    const isValidStatus = statuses.includes(status as string);
    try {
        const [result] = isValidStatus
        ? await db.query("SELECT buyer_request.amount,buyer_request.buy_id,buyer_request.buyer_id, buyer_request.status,buyer_request.request_time,buyer_request.phone_number,transactions.seller_phone,transactions.transactions_id, transactions.transactionId ,isps.name as network_name,transactions.transactions_id, transactions.seller_marked_success, dispute.sender_url FROM buyer_request LEFT JOIN transactions ON transactions.buy_id=buyer_request.buy_id JOIN phone_numbers ON phone_numbers.phone_number=buyer_request.phone_number JOIN isps ON phone_numbers.network=isps.network_id LEFT JOIN dispute ON transactions.transactions_id = dispute.trans_id WHERE status = ? AND seller_id = ?", [status, uuid]): await db.query("SELECT buyer_request.amount,buyer_request.buy_id,buyer_request.buyer_id, buyer_request.status,buyer_request.request_time,buyer_request.phone_number,transactions.seller_phone,transactions.transactions_id,transactions.transactionId,transactions.seller_marked_success  ,isps.name as network_name,transactions.transactions_id, transactions.seller_marked_success, dispute.sender_url FROM buyer_request JOIN transactions ON transactions.buy_id=buyer_request.buy_id JOIN phone_numbers ON phone_numbers.phone_number=buyer_request.phone_number JOIN isps ON phone_numbers.network=isps.network_id LEFT JOIN dispute ON transactions.transactions_id = dispute.trans_id WHERE seller_id = ?",[uuid])
        res.send(result);
    } catch (error) {
        res.status(500).send(error);
    }
})
router.get("/latest_trans",auth,async(req: Request & IUser, res)=>{
    const { id: uuid } = req.user!;
    try {
        const [result] = await db.query("SELECT buyer_request.amount,buyer_request.buy_id,buyer_request.buyer_id, buyer_request.status,buyer_request.request_time,buyer_request.phone_number,transactions.seller_phone,transactions.transactions_id ,isps.name as network_name FROM buyer_request LEFT JOIN transactions ON transactions.buy_id=buyer_request.buy_id JOIN phone_numbers ON phone_numbers.phone_number=buyer_request.phone_number JOIN isps ON phone_numbers.network=isps.network_id WHERE seller_id = ? OR buyer_request.buyer_id = ? LIMIT 4",[uuid,uuid])
        res.send(result);
    } catch (error) {
        res.status(500).send(error);
    }
})
router.put("/solve_dispute",auth,async(req: Request & IUser, res)=>{
    const validate=validateDisputeParams.safeParse(req.body);
    if(!validate.success)  {
        res.status(400).send(validate.error.message)
        return
    } 
    const {transactionId,action,imageUrl}=req.body;
    try {
        const [result]= action=="sell"?await db.query("UPDATE dispute set sender_url = ? where trans_id =? ",[imageUrl,transactionId]):await db.query("UPDATE dispute set buyer_url = ? where trans_id =? ",[imageUrl,transactionId])
        if(result.affectedRows>0){
            res.send({success:true})
        }
    } catch (error) {
        console.log("Error says that ========")
        console.log(error)
        res.send(error)
    }
})
router.get("/buys_total",auth,async(req: Request & IUser,res)=>{
    const { id: uuid } = req.user!;
    try {
       const [results]= await db.query("SELECT COUNT(*) AS notifs FROM transactions JOIN buyer_request ON buyer_request.buy_id=transactions.buy_id JOIN dispute ON transactions.transactions_id= dispute.trans_id   WHERE buyer_request.buyer_id=? AND( buyer_request.status = 'processing' OR (transactions.transaction_status = 'dispute' AND dispute.buyer_url IS NULL ))",[uuid]) 
       res.send(results[0])
    } catch (error) {
        res.send(error)
    }
})

router.get("/sells_total",auth,async(req: Request & IUser,res)=>{
    const { id: uuid } = req.user!;
    try {
       const [results]= await db.query("SELECT COUNT(*) AS notifs FROM transactions JOIN dispute ON transactions.transactions_id= dispute.trans_id   WHERE transactions.seller_id=? AND( transactions.transaction_status = 'pending' OR ( transactions.transaction_status = 'dispute' AND dispute.sender_url IS NULL ))",[uuid]) 
       res.send(results[0])
    } catch (error) {
        res.send(error)
    }
})

export default router;

