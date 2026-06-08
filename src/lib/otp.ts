import crypto from "crypto";
import bcrypt from "bcryptjs";

// Génère un code OTP numérique à 6 chiffres (ex. "048213").
export function generateOtpCode(): string {
  const n = crypto.randomInt(0, 1_000_000); // 0..999999
  return n.toString().padStart(6, "0");
}

export function hashOtp(code: string): Promise<string> {
  return bcrypt.hash(code, 8);
}

export function verifyOtp(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}
