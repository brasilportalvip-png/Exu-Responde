# Exu Responde

Aplicação React/Vite com API Express, autenticação Firebase, Firestore, Gemini e pagamentos Mercado Pago.

## Desenvolvimento local

Requisitos: Node.js 22 ou superior e uma cópia de `.env.example` salva como `.env.local` com credenciais válidas.

```bash
npm ci
npm run dev
```

Validação antes de publicar:

```bash
npm run lint
npm test
npm run build
```

## Configuração obrigatória na Vercel

Cadastre as variáveis abaixo em **Settings → Environment Variables** para Production, Preview e Development:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `GEMINI_API_KEY`
- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_WEBHOOK_SECRET`
- `APP_URL` — em produção: `https://exu-responde.vercel.app`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `ADMIN_SALES_EMAIL` — disparo de confirmação de Axé e outbox
- `ENFORCE_APP_CHECK` — modo estrito antibot ("true" ou "false")

As três variáveis `FIREBASE_*` devem vir da mesma conta de serviço do projeto Firebase `exu-responde`. A chave privada pode ser colada com quebras de linha reais ou com `\n`.

## Política Financeira e Estornos
- **Compras financeiras:** estorno monetário nunca é automático; requer solicitação do titular e análise manual administrativa via suporte.
- **Falhas de consulta técnica (IA/timeout):** créditos debitados são estornados de imediato e automaticamente no saldo do usuário.

Depois de alterar variáveis na Vercel, faça um novo deployment. Confirme a inicialização da API acessando:

```text
https://exu-responde.vercel.app/api/health
```

O resultado esperado em produção é HTTP `200` com `status: "ok"`. O endpoint nunca exibe valores de credenciais.

## Firebase Authentication

- O provedor **E-mail/senha** deve estar habilitado.
- `exu-responde.vercel.app` e qualquer domínio personalizado devem constar em **Authentication → Settings → Authorized domains**.
- O Firestore precisa estar criado no mesmo projeto informado por `FIREBASE_PROJECT_ID`.

## Arquitetura de execução

- A Vercel carrega `api/index.ts`, que exporta a aplicação Express sem abrir uma porta própria.
- Usuários, histórico de conversas, biblioteca personalizada e registros operacionais persistem no Firestore; `/tmp` é apenas apoio local da função.
- `npm run dev` inicia o Express com o Vite em modo middleware.
- `npm start` serve o bundle gerado em `dist`.