
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    timeout: 30000,
  },
});

async function main() {
  try {
    console.log('Saadan päringu Gemini 3.8 Flash mudelile...');

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: 'Ütle eesti keeles: Tere, API töötab!',
      config: {
        maxOutputTokens: 100,
      },
    });

    console.log('\nEDU! Gemini vastas:');
    console.log(response.text);

  } catch (error) {
    console.error('\nPÄRING EBAÕNNESTUS!');
    console.error('Staatus:', error.status);
    console.error('Viga:', error.message);
  }
}

main();
