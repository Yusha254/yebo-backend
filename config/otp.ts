import crypto from 'crypto';

export default function generateSecureOtp(length = 6): string {
  const otp = crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
  return otp;
}


