import { env } from "./env";

export interface GeminiTurn {
  role: "user" | "model";
  text: string;
}

const SYSTEM_PREAMBLE =
  "Tu es l'assistant intégré à Alanya, une messagerie. Réponds de façon concise, " +
  "utile et chaleureuse, en français par défaut (ou dans la langue de l'utilisateur).";

/// Génère une réponse à partir de l'historique de la conversation.
/// Si aucune clé GEMINI_API_KEY n'est configurée, renvoie une réponse de repli (mode dev).
export async function generateReply(history: GeminiTurn[]): Promise<string> {
  const apiKey = env.gemini.apiKey;
  const last = history.filter((t) => t.role === "user").at(-1)?.text ?? "";

  if (!apiKey) {
    return (
      "🔌 (Mode démo — clé Gemini non configurée)\n" +
      "Configure GEMINI_API_KEY dans backend/.env pour activer les vraies réponses.\n\n" +
      `Tu as écrit : « ${last} »`
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent` +
    `?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PREAMBLE }] },
    contents: history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini a renvoyé ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return text.trim() || "(réponse vide)";
}
