// Importações Deno
import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { Server } from "https://deno.land/x/socket_io@0.2.0/mod.ts";

// Tipos
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

// Configuração do servidor
const app = new Application();
const router = new Router();

// Configuração do Socket.IO
const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware para CORS
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  await next();
});

// Middleware para parsear JSON
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

// Função para gerar ID único
const gerarId = (): string => crypto.randomUUID();

// Rotas
router.post('/gerar', async (ctx) => {
  const { tipo } = ctx.state.body;

  if (!tipo || !['O', 'L'].includes(tipo)) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Tipo inválido. Use "O" ou "L".' };
    return;
  }

  state.contadores[tipo]++;
  const novaSenha = `${tipo}${state.contadores[tipo].toString().padStart(3, '0')}`;
  state.filaSenhas[tipo].push(novaSenha);

  io.emit('nova-senha', {
    senha: novaSenha,
    tipo,
    numero: state.contadores[tipo],
    posicao: state.filaSenhas[tipo].length
  });

  ctx.response.body = { senha: novaSenha, tipo, numero: state.contadores[tipo] };
});

router.post('/chamar', async (ctx) => {
  const { guiche, senha } = ctx.state.body;

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

  if (tipo === 'O' && guiche === 3) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Senha ocupacional não pode ser chamada no guichê 3' };
    return;
  }

  if (tipo === 'L' && guiche !== 3) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Senha laboratorial só pode ser chamada no guichê 3' };
    return;
  }

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
  
  io.emit('senha-chamada', chamada);
  io.emit('atualizacao-fila', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  ctx.response.body = chamada;
});

router.post('/finalizar-atendimento', async (ctx) => {
  const { senha } = ctx.state.body;
  
  const chamada = state.senhasChamadas.find(s => s.senha === senha);
  if (!chamada) {
    ctx.response.status = 404;
    ctx.response.body = { error: 'Senha não encontrada' };
    return;
  }

  chamada.finalizado = true;
  chamada.atendido = true;
  
  io.emit('senha-finalizada', { id: chamada.id });
  
  ctx.response.body = { sucesso: true };
});

router.get('/senhas-chamadas-exames', (ctx) => {
  const senhasFiltradas = state.senhasChamadas
    .filter(s => !s.finalizado && !s.encaminhadoConsultorio)
    .reduce((acc: Record<number, string>, curr) => {
      acc[curr.guiche] = curr.senha;
      return acc;
    }, {});

  ctx.response.body = senhasFiltradas;
});

router.post('/confirmar-exames', async (ctx) => {
  const { senha, guiche, exames } = ctx.state.body;

  if (!senha || !guiche || !exames || !Array.isArray(exames)) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Dados inválidos' };
    return;
  }

  const chamadaExistente = state.senhasChamadas.find(s => 
    s.senha === senha && s.guiche === guiche && !s.finalizado
  );

  if (!chamadaExistente) {
    ctx.response.status = 404;
    ctx.response.body = { error: 'Senha não encontrada para esse guichê' };
    return;
  }

  const examesNormalizados = [...new Set(exames.map(e => e.trim()))];
  
  chamadaExistente.exames = examesNormalizados;
  chamadaExistente.encaminhadoConsultorio = true;

  io.emit('senha-consultorio', {
    id: chamadaExistente.id,
    senha,
    exames: examesNormalizados,
    guicheOrigem: guiche,
    timestamp: new Date(),
    finalizado: false,
    atendido: false
  });

  ctx.response.body = { 
    sucesso: true, 
    senha, 
    exames: examesNormalizados 
  };
});

router.post('/marcar-atendido', async (ctx) => {
  const { id } = ctx.state.body;

  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) {
    ctx.response.status = 404;
    ctx.response.body = { error: 'Senha não encontrada' };
    return;
  }

  chamada.finalizado = true;
  chamada.atendido = true;
  
  io.emit('senha-finalizada', { id });
  io.emit('atualizacao-fila', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  ctx.response.body = { sucesso: true };
});

router.get('/senhas-consultorio', (ctx) => {
  const apenasNaoAtendidos = ctx.request.url.searchParams.get('apenasNaoAtendidos') === 'true';
  
  let senhasFiltradas = state.senhasChamadas
    .filter(s => s.exames && s.exames.length > 0 && s.encaminhadoConsultorio);

  if (apenasNaoAtendidos) {
    senhasFiltradas = senhasFiltradas.filter(s => !s.atendido);
  }

  ctx.response.body = senhasFiltradas.map(s => ({
    id: s.id,
    senha: s.senha,
    exames: s.exames,
    guicheOrigem: s.guiche,
    timestamp: s.timestamp
  }));
});

router.post('/remover-exame', async (ctx) => {
  const { id, exame } = ctx.state.body;

  if (!id || !exame) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'ID e exame são obrigatórios' };
    return;
  }

  const chamada = state.senhasChamadas.find(c => c.id === id);
  if (!chamada) {
    ctx.response.status = 404;
    ctx.response.body = { error: 'Paciente não encontrado' };
    return;
  }

  if (!chamada.exames || !chamada.exames.includes(exame)) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Exame não encontrado para este paciente' };
    return;
  }

  chamada.exames = chamada.exames.filter(e => e !== exame);

  if (chamada.exames.length === 0) {
    chamada.atendido = true;
    chamada.finalizado = true;
  }

  io.emit('senha-consultorio', state.senhasChamadas.filter(s => 
    s.exames && s.exames.length > 0 && !s.atendido
  ));

  ctx.response.body = { 
    success: true,
    message: 'Exame removido com sucesso',
    paciente: {
      id: chamada.id,
      examesRestantes: chamada.exames,
      atendido: chamada.atendido
    }
  };
});

router.get('/estado', (ctx) => {
  ctx.response.body = {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse(),
    contadores: state.contadores
  };
});

// Socket.IO events
io.on("connection", (socket) => {
  console.log("Novo cliente conectado");
  
  socket.emit('estado-inicial', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  socket.on("disconnect", () => {
    console.log("Cliente desconectado");
  });
});

// Limpeza periódica
setInterval(() => {
  const agora = new Date();
  const umDia = 24 * 60 * 60 * 1000;
  
  state.senhasChamadas = state.senhasChamadas.filter(s => {
    return !s.finalizado || (agora.getTime() - s.timestamp.getTime()) < umDia;
  });
}, 3600000); // 1 hora

// Inicialização do servidor
const PORT = parseInt(Deno.env.get("PORT") || "8000");
const server = Deno.listen({ port: PORT });
console.log(`Servidor rodando na porta ${PORT}`);

// Integração Oak + Socket.IO
for await (const conn of server) {
  const httpConn = Deno.serveHttp(conn);
  for await (const requestEvent of httpConn) {
    if (requestEvent.request.headers.get("upgrade") === "websocket") {
      // @ts-ignore - Tipagem não reconhecida
      const { socket, response } = Deno.upgradeWebSocket(requestEvent.request);
      io.engine.on("connection", (wsSocket) => {
        socket.onmessage = (event) => wsSocket.emit("data", event.data);
        socket.onclose = () => wsSocket.emit("close");
      });
      await requestEvent.respondWith(response);
    } else {
      await app.handle(requestEvent.request, requestEvent.respondWith);
    }
  }
}