// E-mail com a resposta da administração para quem escreveu no Fale conosco.
// Mesmo visual dos e-mails de cadastro/senha (supabase/emails/), responsivo.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const paragraphs = (s) => esc(s).replace(/\r?\n/g, "<br>");

export function contactReplyEmail({ name, protocol, reason, message, reply }) {
  const firstName = String(name).trim().split(/\s+/)[0];
  const subject = `Resposta à sua mensagem (${protocol}) · Sunfood`;
  const text =
    `Olá, ${firstName}!\n\n${reply}\n\n` +
    `Equipe Sunfood\n\n---\nSua mensagem (${protocol} · ${reason}):\n${message}\n\n` +
    `Precisa de mais alguma coisa? Escreva de novo pelo Fale conosco em https://sunfood.app.br`;
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{border:0;outline:none;text-decoration:none}
  a{color:#0B6670}
  @media only screen and (max-width:520px){
    .sf-outer{padding:12px 8px !important}
    .sf-pad{padding-left:20px !important;padding-right:20px !important}
    .sf-h1{font-size:24px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background:#F6F3EC;color:#12232E;font-family:'DM Sans',Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F6F3EC">${esc(reply.slice(0, 120))}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F3EC">
    <tr><td align="center" class="sf-outer" style="padding:32px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E3DDD0;border-radius:24px;overflow:hidden">
        <tr><td align="center" bgcolor="#0B6670" class="sf-pad" style="background:#0B6670;padding:28px 32px 24px">
          <img src="https://sunfood.app.br/icons/icon-192.png" width="56" height="56" alt="☀" style="display:block;width:56px;height:56px;border-radius:14px;margin:0 auto;color:#FFB21E;font-size:40px;line-height:56px">
          <div style="margin-top:12px;font-family:'Bricolage Grotesque',Arial,Helvetica,sans-serif;font-size:28px;line-height:32px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px">Sunfood</div>
          <div style="margin-top:4px;font-size:14px;line-height:20px;color:#FFE3A3">Resposta ao seu Fale conosco</div>
        </td></tr>
        <tr><td class="sf-pad" style="padding:32px 32px 8px">
          <h1 class="sf-h1" style="margin:0 0 14px;font-family:'Bricolage Grotesque',Arial,Helvetica,sans-serif;font-size:26px;line-height:32px;font-weight:800;color:#12232E;letter-spacing:-0.5px">Olá, ${esc(firstName)}! 👋</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:25px;color:#12232E">${paragraphs(reply)}</p>
          <p style="margin:0;font-size:16px;line-height:25px;color:#5A6670">Equipe Sunfood</p>
        </td></tr>
        <tr><td class="sf-pad" style="padding:20px 32px 28px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E7F1F1;border-radius:14px">
            <tr><td style="padding:14px 16px;font-size:14px;line-height:21px;color:#084C53">
              <div style="font-weight:700;margin-bottom:4px">Sua mensagem · ${esc(protocol)} · ${esc(reason)}</div>
              <div style="word-break:break-word">${paragraphs(message)}</div>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" class="sf-pad" style="background:#F6F3EC;border-top:1px solid #E3DDD0;padding:20px 32px;font-size:12px;line-height:19px;color:#5A6670">
          Você recebeu este e-mail porque escreveu para o Sunfood pelo Fale conosco.<br>Precisa de mais alguma coisa? Escreva de novo pelo site.<br>
          <a href="https://sunfood.app.br" style="color:#0B6670;text-decoration:none;font-weight:700">sunfood.app.br</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html, text };
}
