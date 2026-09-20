import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Configure SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY no .env (veja .env.example)."
  );
}

// Fala com o GoTrue (login, cadastro, recuperação de senha) e valida tokens
// de usuário. Usa a chave anônima — nunca teria como fazer nada privilegiado.
export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Acessa o Postgres direto via service role, ignorando RLS de propósito: é
// este servidor — não o banco — quem aplica RN01, RN04 e RBAC antes de
// gravar qualquer coisa. Por isso a policy de INSERT em orders/order_items
// foi removida para usuários comuns na migração do schema: todo pedido tem
// que passar por aqui. NUNCA expor SUPABASE_SERVICE_ROLE_KEY ao front-end.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
