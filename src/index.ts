import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = createServer(app);

// Configuração do CORS
app.use(cors());
app.use(express.json());

// Configuração do Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
  }
});


type TipoSenha = 'O' | 'L';

// Interface estendida para incluir estado de atendimento
interface Chamada {
  id: string;
  senha: string;
  guiche: number;
  timestamp: Date;
  exames: string[];
  encaminhadoConsultorio?: boolean;
  finalizado?: boolean;
  atendido?: boolean;
  emAtendimento?: boolean;
  exameAtual?: string | null;
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

// Rota principal para testar
app.get('/', (req, res) => {
  res.json({ status: 'API de senhas online ✅' });
});

// Rotas principais
app.post('/gerar', (req: Request, res: Response) => {
  const { tipo } = req.body;

  if (!tipo || !['O', 'L'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido. Use "O" ou "L".' });
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

  return res.json({ 
    senha: novaSenha, 
    numero: state.contadores[tipo as TipoSenha], 
    tipo 
  });
});

app.post('/chamar', (req: Request, res: Response) => {
  const { guiche, senha } = req.body;

  if (!guiche || typeof guiche !== 'number' || guiche < 1 || guiche > 3) {
    return res.status(400).json({ error: 'Número do guichê inválido. Deve ser 1, 2 ou 3.' });
  }

  const tipoSenha = senha[0] as TipoSenha;

  if (state.filaSenhas[tipoSenha].length === 0) {
    return res.status(400).json({ error: 'Senha não encontrada na fila' });
  }

  const senhaIndex = state.filaSenhas[tipoSenha].indexOf(senha);
  if (senhaIndex === -1) {
    return res.status(400).json({ error: 'Senha não encontrada na fila' });
  }

  if (tipoSenha === 'O' && guiche === 3) {
    return res.status(400).json({ error: 'Senha ocupacional não pode ser chamada no guichê 3' });
  }

  if (tipoSenha === 'L' && guiche !== 3) {
    return res.status(400).json({ error: 'Senha laboratorial só pode ser chamada no guichê 3' });
  }

  const senhaChamada = state.filaSenhas[tipoSenha].splice(senhaIndex, 1)[0];

  const chamada: Chamada = {
    id: gerarId(),
    senha: senhaChamada,
    guiche,
    timestamp: new Date(),
    exames: [],
    finalizado: false,
    atendido: false,
    emAtendimento: false,
    exameAtual: null
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

  res.json(chamada);
});

app.post('/finalizar-atendimento', (req: Request, res: Response) => {
  const { senha } = req.body;
  
  const chamada = state.senhasChamadas.find(s => s.senha === senha);
  if (!chamada) {
    return res.status(404).json({ error: 'Senha não encontrada' });
  }

  chamada.finalizado = true;
  chamada.atendido = true;
  chamada.emAtendimento = false;
  chamada.exameAtual = null;
  
  io.emit('senha-finalizada', { id: chamada.id });
  io.emit('atualizacao-atendimento', {
    id: chamada.id,
    emAtendimento: false,
    exameAtual: null
  });
  
  res.json({ sucesso: true });
});

app.get('/senhas-chamadas-exames', (req: Request, res: Response) => {
  const senhasFiltradas = state.senhasChamadas
    .filter(s => !s.finalizado && !s.encaminhadoConsultorio)
    .reduce((acc: {[key: number]: string}, curr) => {
      acc[curr.guiche] = curr.senha;
      return acc;
    }, {});

  res.json(senhasFiltradas);
});

// Rotas para consultório
app.post('/confirmar-exames', async (req: Request, res: Response) => {
  try {
    const { senha, guiche, exames, action, id }: ExamePayload = req.body;

    // Validação básica
    if (!senha || !guiche || !exames || !Array.isArray(exames)) {
      return res.status(400).json({ 
        sucesso: false,
        mensagem: 'Dados inválidos' 
      });
    }

    if (action === 'editar' && !id) {
      return res.status(400).json({
        sucesso: false,
        mensagem: 'ID é obrigatório para edição'
      });
    }

    // Encontra a senha no estado
    let chamada = state.senhasChamadas.find(s => 
      action === 'editar' ? s.id === id : s.senha === senha && s.guiche === guiche
    );

    if (!chamada) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Senha não encontrada'
      });
    }

    // Atualiza os exames
    chamada.exames = [...new Set(exames)]; // Remove duplicatas

    if (action === 'confirmar') {
      chamada.encaminhadoConsultorio = true;
    }

    // Notifica todos os clientes via Socket.IO
    io.emit('senha-consultorio', chamada);

    res.json({
      sucesso: true,
      mensagem: `Exames ${action === 'confirmar' ? 'confirmados' : 'atualizados'} com sucesso`
    });

  } catch (error) {
    console.error('Erro em confirmar-exames:', error);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro interno no servidor'
    });
  }
});


// Nova rota para marcar em atendimento
app.post('/marcar-em-atendimento', (req: Request, res: Response) => {
  const { id, emAtendimento, exameAtual } = req.body;

  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) {
    return res.status(404).json({ error: 'Senha não encontrada' });
  }

  chamada.emAtendimento = emAtendimento;
  chamada.exameAtual = exameAtual;

  io.emit('atualizacao-atendimento', {
    id,
    emAtendimento,
    exameAtual
  });

  res.json({ 
    sucesso: true,
    senha: chamada.senha,
    emAtendimento,
    exameAtual
  });
});

app.post('/marcar-atendido', (req: Request, res: Response) => {
  const { id } = req.body;

  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) {
    return res.status(404).json({ error: 'Senha não encontrada' });
  }

  chamada.finalizado = true;
  chamada.atendido = true;
  chamada.emAtendimento = false;
  chamada.exameAtual = null;
  
  io.emit('senha-finalizada', { id });
  io.emit('atualizacao-atendimento', {
    id,
    emAtendimento: false,
    exameAtual: null
  });
  io.emit('atualizacao-fila', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  res.json({ sucesso: true });
});

app.get('/senhas-consultorio', (req: Request, res: Response) => {
  const apenasNaoAtendidos = req.query.apenasNaoAtendidos === 'true';
  
  let senhasFiltradas = state.senhasChamadas
    .filter(s => s.exames && s.exames.length > 0 && s.encaminhadoConsultorio);

  if (apenasNaoAtendidos) {
    senhasFiltradas = senhasFiltradas.filter(s => !s.atendido);
  }

  res.json(senhasFiltradas.map(s => ({
    id: s.id,
    senha: s.senha,
    exames: s.exames,
    guicheOrigem: s.guiche,
    timestamp: s.timestamp,
    emAtendimento: s.emAtendimento,
    exameAtual: s.exameAtual
  })));
});

app.post('/remover-exame', (req: Request, res: Response) => {
  const { id, exame } = req.body;

  if (!id || !exame) {
    return res.status(400).json({ error: 'ID e exame são obrigatórios' });
  }

  const chamada = state.senhasChamadas.find(c => c.id === id);

  if (!chamada) {
    return res.status(404).json({ error: 'Paciente não encontrado' });
  }

  if (!chamada.exames || !chamada.exames.includes(exame)) {
    return res.status(400).json({ error: 'Exame não encontrado para este paciente' });
  }

  chamada.exames = chamada.exames.filter(e => e !== exame);

  if (chamada.exames.length === 0) {
    chamada.atendido = true;
    chamada.finalizado = true;
    chamada.emAtendimento = false;
    chamada.exameAtual = null;
  }

  io.emit('senha-consultorio', state.senhasChamadas.filter(s => 
    s.exames && s.exames.length > 0 && !s.atendido
  ));

  res.json({ 
    success: true,
    message: 'Exame removido com sucesso',
    paciente: {
      id: chamada.id,
      examesRestantes: chamada.exames,
      atendido: chamada.atendido
    }
  });
});

// Rotas de consulta
app.get('/estado', (req: Request, res: Response) => {
  res.json({
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse(),
    contadores: state.contadores
  });
});
// Nova rota para gerar ZPL
app.get('/gerar-zpl', (req: Request, res: Response) => {
  const { senha, tipo } = req.query;

  if (!senha || !tipo) {
      return res.status(400).json({ error: 'Parâmetros "senha" e "tipo" são obrigatórios' });
  }

  // Layout ZPL básico para a Zebra GC420T
  const zpl = `
  ^XA
  ^CF0,40
  ^FO50,30^FDClinica Medica^FS
  ^FO50,80^FDSenha: ${tipo}${String(senha).padStart(3, '0')}^FS
  ^FO50,130^FDData: ${new Date().toLocaleDateString()}^FS
  ^FO50,180^FDHora: ${new Date().toLocaleTimeString()}^FS
  ^XZ
  `;

  res.set('Content-Type', 'text/plain');
  res.send(zpl);
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Novo cliente conectado');
  
  socket.emit('estado-inicial', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// Middleware de erro
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

app.use((err: any, req: Request, res: Response, next: any) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Inicialização do servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Limpeza periódica
setInterval(() => {
  const agora = new Date();
  const umDia = 24 * 60 * 60 * 1000;
  
  state.senhasChamadas = state.senhasChamadas.filter(s => {
    return !s.finalizado || (agora.getTime() - new Date(s.timestamp).getTime()) < umDia;
  });
}, 3600000);