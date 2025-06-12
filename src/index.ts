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
  tipo: 'ocupacional' | 'laboratorial';
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
    exameAtual: null,
    tipo: tipoSenha === 'O' ? 'ocupacional' : 'laboratorial' 
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

  io.emit('atualizar-senha-consultorio', chamada);

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

app.post('/chamar', (req: Request, res: Response) => {More actions
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
// Adicione estas rotas antes do middleware de 404

// Rota para obter senhas de exames chamadas
app.get('/senhas-chamadas-exames', (req: Request, res: Response) => {
  try {
    const senhasExames = state.senhasChamadas.filter(chamada => {
      return chamada.senha.startsWith('O') && chamada.encaminhadoConsultorio;
    });
    
    res.status(200).json({
      success: true,
      data: senhasExames
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar senhas de exames'
    });
  }
});

// Rota para obter senhas de consultório
app.get('/senhas-consultorio', (req: Request, res: Response) => {
  try {
    const { apenasNaoAtendidos } = req.query;
    
    let senhasFiltradas = state.senhasChamadas.filter(chamada => {
      return chamada.senha.startsWith('L') || chamada.encaminhadoConsultorio;
    });
    
    if (apenasNaoAtendidos === 'true') {
      senhasFiltradas = senhasFiltradas.filter(chamada => !chamada.atendido);
    }
    
    res.status(200).json({
      success: true,
      data: senhasFiltradas
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar senhas de consultório'
    });
  }
});

// Rota para marcar senha como atendida no consultório
app.post('/senhas-consultorio/marcar-atendido', (req: Request, res: Response) => {
  try {
    const { id } = req.body;
    
    const chamada = state.senhasChamadas.find(s => s.id === id);
    if (!chamada) {
      return res.status(404).json({ success: false, message: 'Senha não encontrada' });
    }
    
    chamada.atendido = true;
    chamada.finalizado = true;
    io.emit('senha-finalizada', chamada.id);
    
    io.emit('senha-atendida-consultorio', { id });
    
    res.status(200).json({
      success: true,
      data: chamada
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao marcar senha como atendida'
    });
  }
});

// Adicione esta rota se precisar de uma específica para exames não atendidos
app.get('/senhas-exames-nao-atendidos', (req: Request, res: Response) => {
  try {
    const senhas = state.senhasChamadas.filter(chamada => {
      return chamada.senha.startsWith('O') && 
             chamada.encaminhadoConsultorio && 
             !chamada.atendido;
    });
    
    res.status(200).json({
      success: true,
      data: senhas
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar senhas de exames não atendidos'
    });
  }
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
