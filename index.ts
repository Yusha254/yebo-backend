import express from 'express';
import path from 'path';
import user from "./routes/user"
import phone from "./routes/phone"
import network from "./routes/network"
import payment from "./routes/payment"
import transactions from "./routes/transactions"
import admin from "./routes/admin"
import coins from "./routes/coins"
import marketplace from "./routes/marketplace"
import webhook from "./routes/webhook"
import cors from "cors";
const app = express();
const corsOptions = {
  origin: ["http://localhost:5173","https://admin.yebovoucher.africa"],
  credentials: true,
  exposedHeaders: ["x-auth-admin"],
  allowedHeaders: ["Content-Type", "x-auth-admin"], // 👈 ADD
};


app.use(express.json());
app.use(cors(corsOptions));

app.use(express.static(path.join(__dirname, 'public')));
app.use("/api/users",user)
app.use("/api/phone",phone)
app.use("/api/network",network)
app.use("/api/payment",payment)
app.use("/api/transactions",transactions)
app.use("/api/admin",admin)
app.use("/api/coins",coins)
app.use("/api/marketplace",marketplace)
app.use("/api/webhook", webhook)

app.get("/",(req,res)=>{
  res.send("/start")
})

const PORT = 3023;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
