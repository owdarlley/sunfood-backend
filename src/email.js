// Envia e-mails da própria API (ex.: resposta do Fale conosco) pela Resend,
// o mesmo serviço que o Supabase usa como SMTP para confirmar cadastro e
// redefinir senha. Os e-mails do Supabase continuam saindo pelo Supabase;
// aqui só passam os que a API manda por conta própria.
const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Sunfood <nao-responda@sunfood.app.br>";

export function emailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!emailConfigured()) {
    const err = new Error("RESEND_API_KEY não configurada.");
    err.code = "email_not_configured";
    throw err;
  }
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || DEFAULT_FROM,
      to: [to],
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error("Resend respondeu " + res.status + ": " + detail.slice(0, 300));
    err.code = "email_failed";
    throw err;
  }
  return res.json();
}
