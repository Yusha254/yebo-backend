import { Request, Router } from "express";
import { v4 as uuidv4 } from 'uuid';
import db from "../config/db";
import generateSecureOtp from "../config/otp";
import { validateAirtime, validateCode, validateDeletePhone, validatePhoneSchema, validateUpdateOtp } from "../config/validators";
import auth, { IUser } from "../middleware/auth";
import { normalizeNumber } from "../config/sendsms";
const router=Router();

router.post("/",auth,async(req:Request&IUser,res)=>{
    const validate=validatePhoneSchema.safeParse(req.body);
    if(!validate.success) { 
        res.send(validate.error.message)
        return;
    }
    const {phone,network}=req.body;
    const phoneId=uuidv4();
    const {id:uuid}=req.user!
    const stored_number=normalizeNumber(phone)
    try {
       const [existing]= await db.query("SELECT * FROM phone_numbers where phone_number = ?",[stored_number])
    if(existing.length>0){
        res.status(400).send('user already registered');
        return;
    }
    const otp=generateSecureOtp(6);
    //  const send=await sendSMS(stored_number,`${otp} is your Yebo Verification Code`)
    //  console.log(send)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const [result] =await db.query("INSERT INTO phone_numbers (phoneid,uuid,phone_number,network,otp_code,otp_expires_at) VALUES(?,?,?,?,?,?)",[phoneId,uuid,stored_number,network,otp,expiresAt]);
    res.send(result); 
    } catch (error) {
        console.log(error)
        res.status(500).send('error saving number')
    } 
})
router.post("/verify",auth,async(req,res)=>{
    const validate=validateCode.safeParse(req.body);
    if(!validate.success){
        res.status(400).send(validate.error.message)
        return
    }
    const {phone,code}=req.body;
    const stored_number=normalizeNumber(phone)
    try {
        const [rows]=await db.query("SELECT * FROM phone_numbers WHERE phone_number = ?",[stored_number])
        if(rows.length<1){
	    console.log('phone number not registered')
            res.status(400).send('phone number not registered')
            return
        }
        const phonedata =rows[0];
        if(phonedata.otp_code!==code){
	    console.log('Invalid code')
            res.status(400).send('Invalid code');
            return;
        }
        if(phonedata.is_verified){
	    console.log('user already verified')
            res.status(400).send('user already verified')
            return ;
        }
        const now =new Date();
        const expiry=new Date(phonedata.otp_expires_at)
        if(now>expiry){
            res.status(400).send('Invalid code')
            return ;
        }
        await db.query("UPDATE phone_numbers SET is_verified = true WHERE phone_number = ?",[stored_number])
        res.send('phone number successfully verified')

    } catch (error) {
        console.log(error)
        res.send('error verifying number')
    }
})
router.put('/updateotp',auth,async(req,res)=>{
    const validate=validateUpdateOtp.safeParse(req.body);
    if(!validate.success){
        res.status(400).send(validate.error.message)
        return
    }
    const {phone}=req.body;
    const stored_number=normalizeNumber(phone)
    try {
        const [row]=await db.query("SELECT * FROM phone_numbers WHERE phone_number= ?",[stored_number])
        if(row.length<1){
            res.status(400).send('phone number not registered');
            return;
        }
        const phone_data=row[0]
        if(phone_data.is_verified){
            res.status(400).send('user already verified')
            return ;
        }
        const now =new Date();
        const expiry=new Date(phone_data.otp_expires_at)
        
        if(now<expiry){
            console.log(phone_data.otp_code)
            // const send=await sendSMS(stored_number,`${phone_data.otp_code} is your Yebo Verification Code`)
            // console.log(send)
            res.send(phone_data)
            return ;
        }
        const otp=generateSecureOtp(6);
        
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        const [result]=await db.query("UPDATE phone_numbers SET otp_code= ? ,otp_expires_at = ? where phone_number=?",[otp,expiresAt,stored_number])
        // const send=await sendSMS(stored_number,`${otp} is your Yebo Verification Code`)
        // console.log(send)
        res.send(result)
    } catch (error) {
        console.log(error)
        res.send(500)
    }
})
router.get("/phone_details/:phone",auth,async(req:Request&IUser,res)=>{
    const {phone}=req.params
    try {
        const [row]=await db.query("SELECT * FROM phone_numbers WHERE phone_number= ? ",[phone])
        if(row.length==0){
            console.log(row)
            res.send(400).send('Phone number not available or not registered');
            return
        }
        res.send(row[0])
    } catch (error) {
        
    }  
})
router.get("/phones",auth,async(req:Request&IUser,res)=>{
    const {id:uuid}=req.user!
	
    try {
       const [results]=await db.query("SELECT users.yeboCoins,users.uuid, phone_numbers.phone_number,phone_numbers.network,phone_numbers.is_verified,phone_numbers.airtime,isps.name FROM phone_numbers JOIN users ON phone_numbers.uuid = users.uuid JOIN isps ON phone_numbers.network=isps.network_id WHERE users.uuid = ?",[uuid])
       res.send(results)
    } catch (error) {
	console.log(error)
        res.status(500).send('could not send data')
    }
    
    
})
router.put("/update_airtime",auth,async(req:Request&IUser,res)=>{
	const validate=validateAirtime.safeParse(req.body)
    if(!validate.success){
        res.status(400).send(validate.error.message)
        return
    }
    const {phone,airtime}=req.body
    try {
        const [result]=await db.query("UPDATE phone_numbers SET airtime = ? where phone_number=?",[airtime,phone])
        res.send(result)
    } catch (error) {
        res.send(error)
    }
})
router.delete("/:phone",auth,async(req:Request&IUser,res)=>{
    const {phone}=req.params
    const { id: uuid } = req.user!;
    try {
        const [result]=await db.query("DELETE FROM phone_numbers  WHERE phone_number = ? AND uuid = ?",[phone,uuid])
        res.send(result)
    } catch (error) {
        res.send(error)
    }
})
export default router