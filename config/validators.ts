import { z } from 'zod';

export const validateEmailReg=z.object({
    firstname:z.string().min(3).max(25).trim(),
    lastname:z.string().min(3).max(25).trim(),
    email:z.string().min(6).max(30),
    password:z.string().min(6).max(50),
    address_line:z.string().min(3).max(200),
    city:z.string().min(3).max(30),
    state:z.string().min(3).max(30),
    postal_code:z.string().length(4)
})
export const validateLogin=z.object({
  email:z.string().min(6).max(30),
  password:z.string().min(6).max(50)
})
export const validatePhoneSchema=z.object({
  phone:z.string().min(10).max(13),
  network:z.string().length(36,"Network uuid has 36 characters")
})
export const validateCode=z.object({
  code:z.string().length(6,"code should have 6 characters"),
  phone:z.string().min(10).max(13),
})
export const validateUpdateOtp=z.object({
  phone:z.string().min(10).max(13),
})
export const validateBuyerRequest=z.object({
  phone:z.string().min(10).max(13),
  amount:z.string().min(1).max(10000),
  payment_id:z.string().min(12).max(40)
})
export const validateBookTrans=z.object({
  buy_id:z.string().length(36,"buy_id is not a valid uuid"),
  seller_phone:z.string().min(10,"phone is not valid")
})
export const validateAirtime=z.object({
  phone:z.string().min(10,"Phone should have at least 10 chars").max(15,"Phone should have at most 15 chars"),
  airtime:z.number().min(10).max(5000)
})
export const validateDeletePhone=z.object({
  phone:z.string().min(10,"Phone should have at least 10 chars").max(15,"Phone should have at most 15 chars")
})
export const validateCheckEmail=z.object({
  email:z.string().min(6).max(30)
})
export const validateEmailVerify=z.object({
  code:z.string().length(6,"code should have 6 characters")
})
export const validateDisputeParams=z.object({
  transactionId:z.string().length(36,"buy_id is not a valid uuid"),
  imageUrl:z.string().min(10).max(100),
  action:z.string().min(3).max(6)
})
export const validatePaymentSession =z.object({
  phone:z.string().min(10).max(13),
  amount:z.number().min(1).max(1000000),
})
export const validateWithdrawals=z.object({
  amount:z.number().min(1).max(5000),
  reference_code:z.string().min(7).max(40)
})
export const statusChangeSchema = z.object({
  action: z.enum(["pending", "failed", "success","processing"])
});
export const adminRegisterSchema=z.object({
  firstname:z.string().min(3).max(25).trim(),
  lastname:z.string().min(3).max(25).trim(),
  email:z.string().min(6).max(30),
  password:z.string().min(6).max(50),
  code:z.string().length(4),
})
export type ValData=z.infer<typeof validateEmailReg>

// ── Marketplace validators ────────────────────────────────────────────────────

export const validateCreateOffer = z.object({
  network_id:      z.string().length(36, "network_id must be a valid UUID"),
  seller_phone:    z.string().min(10).max(15),
  airtime_amount:  z.number().min(5,  "Minimum offer is 5"),
  asking_price:    z.number().min(1,  "Asking price must be at least 1"),
})

export const validateTakeOffer = z.object({
  offer_id: z.string().length(36, "offer_id must be a valid UUID"),
})

export const validateEscrowAction = z.object({
  escrow_id: z.string().length(36, "escrow_id must be a valid UUID"),
})