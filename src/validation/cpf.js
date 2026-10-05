// CPF de verdade: 11 dígitos com os dois dígitos verificadores certos. Pega
// número digitado errado ou inventado ("123.456.789-00", "111.111.111-11").
// Não prova que o CPF existe na Receita, só que é um número possível.
export function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const digit = ((sum * 10) % 11) % 10;
    if (digit !== Number(cpf[len])) return false;
  }
  return true;
}
