// Mostra só o começo e o fim do nome do e-mail (darlley1997@gmail.com →
// d*****7@gmail.com): dá pro cliente reconhecer a conta sem expor o e-mail.
export function maskEmail(email) {
  const [user, domain] = email.split("@");
  if (user.length <= 2) return `${user[0]}*@${domain}`;
  return `${user[0]}${"*".repeat(Math.min(user.length - 2, 5))}${user[user.length - 1]}@${domain}`;
}
