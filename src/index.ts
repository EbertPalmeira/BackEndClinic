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
  filaSenhas: { [key in TipoSenha]: string[] };
  senhasChamadas: Chamada[];
  contadores: { O: number; L: number };
}

// Estado principal
const state: Estado = {
  filaSenhas: {
    O: [],
    L: []
  },
  senhasChamadas: [],
  contadores: {
    O: 0,
    L: 0
  }
};

// Função para gerar ID único
const gerarId = () => Math.random().toString(36).substring(2, 15);

// Configuração do servidor
const app = new Application();
const router = new Router();

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
      if (body.type === "json") {
        ctx.state.body = await body.value;
      }
    }
    await next();
  } catch (err) {
    ctx.response.status = 500;
    ctx.response.body = { error: err.message };
  }
});

// Configuração do Socket.IO
const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Conecta o Socket.IO ao servidor Oak
io.attach(app);

// Rotas principais
router.post('/gerar', async (ctx) => {
  const { tipo } = ctx.state.body;

  if (!tipo || !['O', 'L'].includes(tipo)) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Tipo inválido. Use "O" ou "L".' };
    return;
  }

  state.contadores[tipo as TipoSenha] += 1;
  const novaSenha = `${tipo}${String(state.contadores[tipo as TipoSenha]).padStart(3, '0')}`;
  state.filaSenhas[tipo as TipoSenha].push(novaSenha);

  io.emit('nova-senha', {
    senha: novaSenha,
    tipo,
    numero: state.contadores[tipo as TipoSenha],
    posicao: state.filaSenhas[tipo as TipoSenha].length
  });

  ctx.response.body = { senha: novaSenha, numero: state.contadores[tipo as TipoSenha], tipo };
});

router.post('/chamar', async (ctx) => {
  const { guiche, senha } = ctx.state.body;

  if (!guiche || typeof guiche !== 'number' || guiche < 1 || guiche > 3) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Número do guichê inválido. Deve ser 1, 2 ou 3.' };
    return;
  }

  const tipoSenha = senha[0] as TipoSenha;

  if (state.filaSenhas[tipoSenha].length === 0) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Senha não encontrada na fila' };
    return;
  }

  const senhaIndex = state.filaSenhas[tipoSenha].indexOf(senha);
  if (senhaIndex === -1) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Senha não encontrada na fila' };
    return;
  }

  if (tipoSenha === 'O' && guiche === 3) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Senha ocupacional não pode ser chamada no guichê 3' };
    return;
  }

  if (tipoSenha === 'L' && guiche !== 3) {
    ctx.response.status = 400;
    ctx.response.body = { error: 'Senha laboratorial só pode ser chamada no guichê 3' };
    return;
  }

  const senhaChamada = state.filaSenhas[tipoSenha].splice(senhaIndex, 1)[0];

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
  io.emit('senha-chamada-exames', { senha: senhaChamada, guiche });
  
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
    .reduce((acc: {[key: number]: string}, curr) => {
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

// Limpeza periódica de senhas finalizadas
setInterval(() => {
  const agora = new Date();
  const umDia = 24 * 60 * 60 * 1000;
  
  state.senhasChamadas = state.senhasChamadas.filter(s => {
    return !s.finalizado || (agora.getTime() - new Date(s.timestamp).getTime()) < umDia;
  });
}, 3600000); // A cada hora

// Registra as rotas
app.use(router.routes());
app.use(router.allowedMethods());

// Inicia o servidor
const port = Deno.env.get("PORT") || 8000;
console.log(`Servidor rodando em http://localhost:${port}`);
await app.listen({ port: Number(port) });