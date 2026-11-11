
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, 'Gemini API key is missing'),
  PORT: z.coerce.number().default(3000),
});

export const env = envSchema.parse(process.env);
