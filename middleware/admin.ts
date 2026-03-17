import { NextFunction, Request, Response } from "express";
import  jwt  from "jsonwebtoken";
interface tokenSchema{
    email:string,
    id:string,
}
interface IAdmin {
    user?:tokenSchema
}
async function admin(req:Request&IAdmin,res:Response,next:NextFunction) {
    const token = req.header('x-auth-admin')
	
    if(!token) {
        res.status(401).send('token not provided');
        return;
    }
    try {
        const decoded=jwt.verify(token!,process.env.JWT_SECRET as string)
        req.user=decoded as tokenSchema
        next()
    } catch (error) {
	console.log(error)
        res.status(400).send('user not authorised')
    }
}
export default admin