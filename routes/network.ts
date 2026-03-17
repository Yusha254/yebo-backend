import {Router} from "express";
 
import db from "../config/db"
const router=Router()
router.get("/",async(req,res)=>{
    try {
       const [rows]= await db.query("SELECT * FROM isps");
       res.send(rows)
    } catch (error) {
        res.status(500).send(error)
    }
})
export default router