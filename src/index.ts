import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

import fs from 'fs';

dotenv.config();

const PRINTER_PATH = process.env.PRINTER_PATH || 'NÃO DEFINIDO';
const PORT = process.env.PORT || 3001;

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:8080', 'https://clinicshalom.netlify.app/'],
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

app.use(cors({
  origin: ['http://localhost:8080', 'https://clinicshalom.netlify.app/'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], 
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

// ==== Tipos ====
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
  emAtendimento?: boolean;
  exameAtual?: string | null;
  examesOriginais?: string[];
  examesConcluidos?: string[];
}

interface Estado {
  filaSenhas: { [key in TipoSenha]: string[] };
  senhasChamadas: Chamada[];
  contadores: { O: number; L: number };
}

interface ExamePayload {
  senha: string;
  guiche: number;
  exames: string[];
  action?: string;
  id?: string;
}

// ==== Estado do sistema ====
const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

const gerarId = (): string => Math.random().toString(36).substring(2, 15);

// Persistência
// Verifique se o arquivo database.json está sendo criado
const DB_FILE = 'database.json';

const saveState = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
    console.log("Estado salvo com sucesso");
  } catch (error) {
    console.error("Erro ao salvar estado:", error);
  }
};

// ==== ROTAS ====

app.post('/gerar', (req: Request, res: Response) => {
  const { tipo } = req.body;

  if (!tipo || !['O', 'L'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido. Use "O" ou "L".' });
  }

  const tipoSenha = tipo as TipoSenha;
  state.contadores[tipoSenha]++;
  const novaSenha = `${tipo}${String(state.contadores[tipoSenha]).padStart(3, '0')}`;
  state.filaSenhas[tipoSenha].push(novaSenha);

  return res.json({ senha: novaSenha, numero: state.contadores[tipoSenha], tipo });
});

app.post('/chamar', (req: Request, res: Response) => {
  const { guiche, senha } = req.body;

  if (!guiche || typeof guiche !== 'number' || guiche < 1 || guiche > 3) {
    return res.status(400).json({ error: 'Guichê inválido' });
  }

  const tipoSenha = senha[0] as TipoSenha;
  const senhaIndex = state.filaSenhas[tipoSenha].indexOf(senha);
  if (senhaIndex === -1) return res.status(400).json({ error: 'Senha não encontrada' });

  if (tipoSenha === 'O' && guiche === 3) return res.status(400).json({ error: 'Senha ocupacional não pode ir ao guichê 3' });
  if (tipoSenha === 'L' && guiche !== 3) return res.status(400).json({ error: 'Senha laboratorial só vai ao guichê 3' });

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
    exameAtual: null,
    examesOriginais: [],
    examesConcluidos: []
  };

  state.senhasChamadas.push(chamada);

  io.emit('senha-chamada', chamada);
  io.emit('atualizacao-fila', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas.filter(s => !s.finalizado).slice(-5).reverse()
  });
  io.emit('senha-chamada-exames', { senha: senhaChamada, guiche });

  res.json(chamada);
});

app.post('/finalizar-exame', (req: Request, res: Response) => {
   console.log('Requisição recebida em /finalizar-exame', req.body); 
  const { id, exame } = req.body;
  if (!id || !exame) {
     console.log('Dados incompletos:', { id, exame });
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) return res.status(404).json({ error: 'Chamada não encontrada' });

  chamada.examesConcluidos = chamada.examesConcluidos || [];
  if (!chamada.examesConcluidos.includes(exame)) {
    chamada.examesConcluidos.push(exame);
  }

  chamada.exameAtual = null;
  chamada.emAtendimento = false;

  io.emit('atualizar-senha-consultorio', {
    id: chamada.id,
    examesConcluidos: chamada.examesConcluidos,
    emAtendimento: false,
    exameAtual: null
  });

  return res.json({ sucesso: true });
});

app.post('/marcar-em-atendimento', (req: Request, res: Response) => {
  const { id, emAtendimento, exameAtual } = req.body;
  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) return res.status(404).json({ error: 'Chamada não encontrada' });

  chamada.emAtendimento = !!emAtendimento;
  chamada.exameAtual = exameAtual || null;

  io.emit('atualizacao-atendimento', {
    id: chamada.id,
    emAtendimento: chamada.emAtendimento,
    exameAtual: chamada.exameAtual
  });

  return res.json({ sucesso: true, chamada });
});
app.get('/estado', (req: Request, res: Response) => {
  res.json({
    fila: state.filaSenhas,
    chamadas: state.senhasChamadas,
    contadores: state.contadores
  });
});

app.post('/confirmar-exames', (req: Request, res: Response) => {
  const { senha, guiche, exames, action, id }: ExamePayload = req.body;

  if (!senha || !guiche || !Array.isArray(exames)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Dados inválidos' });
  }

  if (action === 'editar' && !id) {
    return res.status(400).json({ sucesso: false, mensagem: 'ID é obrigatório para editar' });
  }

  const chamada = state.senhasChamadas.find(s =>
    action === 'editar' ? s.id === id : s.senha === senha && s.guiche === guiche
  );
  if (!chamada) return res.status(404).json({ sucesso: false, mensagem: 'Senha não encontrada' });

  chamada.exames = [...new Set(exames)];
  chamada.examesOriginais = chamada.examesOriginais || [...exames];
  chamada.examesConcluidos = chamada.examesConcluidos || [];

  if (action === 'confirmar') {
    chamada.encaminhadoConsultorio = true;
    chamada.emAtendimento = true;
    chamada.exameAtual = chamada.exames[0] || null;

    io.emit('atualizacao-atendimento', {
      id: chamada.id,
      emAtendimento: true,
      exameAtual: chamada.exameAtual
    });
  }

  return res.json({ sucesso: true, chamada });
});

// ==== Socket.IO ====
io.on('connection', socket => {
  console.log('Cliente conectado');

  socket.emit('estado-inicial', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas.filter(s => !s.finalizado).slice(-5).reverse()
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// ==== Middleware ====
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ==== Start Server ====
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Configuração de impressora USB: ${PRINTER_PATH}`);
});
