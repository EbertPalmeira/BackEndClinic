// Importações Deno (versões atualizadas)
import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { Server } from "https://deno.land/x/socket_io@0.2.0/mod.ts";

// Tipos e Interfaces
type TipoSenha = 'O' | 'L';

interface Chamada {
  id: string;
  senha: string;
  guiche: number;
  timestamp: Date;
  exames: string[];
  encaminhadoConsultorio?: boolean;
  finalizado?: boolean;
  atendido?: boolean;
}

interface Estado {
  filaSenhas: Record<TipoSenha, string[]>;
  senhasChamadas: Chamada[];
  contadores: Record<TipoSenha, number>;
}

// Estado inicial
const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

// Utilitários
const gerarId = (): string => crypto.randomUUID();

// Configuração do servidor
const app = new Application();
const router = new Router();

// Middlewares
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  await next();
});

app.use(async (ctx, next) => {
  try {
    if (ctx.request.hasBody) {
      const body = ctx.request.body();
      ctx.state.body = body.type === "json" ? await body.value : {};
    }
    await next();
  } catch (err) {
    console.error("Erro no middleware:", err);
    ctx.response.status = 500;
    ctx.response.body = { error: "Erro interno no servidor" };
  }
});

// Socket.IO
const io = new Server({
  cors: { origin: "*", methods: ["GET", "POST"] }
});
io.attach(app);

// Rotas
router
  .post("/gerar", async (ctx) => {
    const { tipo } = ctx.state.body;
    
    if (!tipo || !['O', 'L'].includes(tipo)) {
      ctx.response.status = 400;
      ctx.response.body = { error: 'Tipo de senha inválido' };
      return;
    }

    state.contadores[tipo]++;
    const novaSenha = `${tipo}${state.contadores[tipo].toString().padStart(3, '0')}`;
    state.filaSenhas[tipo].push(novaSenha);

    io.emit("nova-senha", {
      senha: novaSenha,
      tipo,
      numero: state.contadores[tipo],
      posicao: state.filaSenhas[tipo].length
    });

    ctx.response.body = { senha: novaSenha, tipo, numero: state.contadores[tipo] };
  })
  .post("/chamar", async (ctx) => {
    const { guiche, senha } = ctx.state.body;
    
    // Validações
    if (!guiche || !senha || typeof guiche !== 'number') {
      ctx.response.status = 400;
      ctx.response.body = { error: 'Dados inválidos' };
      return;
    }

    const tipo = senha[0] as TipoSenha;
    const senhaIndex = state.filaSenhas[tipo].indexOf(senha);

    if (senhaIndex === -1) {
      ctx.response.status = 404;
      ctx.response.body = { error: 'Senha não encontrada' };
      return;
    }

    // Lógica de chamada
    const [senhaChamada] = state.filaSenhas[tipo].splice(senhaIndex, 1);
    const chamada: Chamada = {
      id: gerarId(),
      senha: senhaChamada,
      guiche,
      timestamp: new Date(),
      exames: [],
      finalizado: false,
      atendido: false
    };

    state.senhasChamadas.push(chamada);
    
    // Emissões Socket.IO
    io.emit("senha-chamada", chamada);
    io.emit("atualizacao-fila", {
      fila: state.filaSenhas,
      ultimasChamadas: state.senhasChamadas
        .filter(s => !s.finalizado)
        .slice(-5)
        .reverse()
    });

    ctx.response.body = chamada;
  });

// ... (demais rotas seguindo o mesmo padrão)

// Socket.IO Events
io.on("connection", (socket) => {
  console.log("Nova conexão:", socket.id);
  
  socket.emit("estado-inicial", {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  socket.on("disconnect", () => {
    console.log("Desconectado:", socket.id);
  });
});

// Limpeza automática
setInterval(() => {
  const now = Date.now();
  state.senhasChamadas = state.senhasChamadas.filter(s => 
    !s.finalizado || (now - s.timestamp.getTime()) < 86400000 // 24h
  );
}, 3600000); // 1 hora

// Inicialização
app.use(router.routes());
app.use(router.allowedMethods());

const PORT = parseInt(Deno.env.get("PORT") || 8000;
console.log(`Servidor iniciado na porta ${PORT}`);
await app.listen({ port: PORT });