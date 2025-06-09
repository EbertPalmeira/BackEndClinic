import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config(); // Carrega variáveis do .env

const PRINTER_PATH = process.env.PRINTER_PATH || 'NÃO DEFINIDO';

const app = express();
const server = createServer(app);
const router = express.Router();

// Configuração CORS
app.use(cors({
  origin: ['http://localhost:8080', 'https://seu-frontend.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

// Configuração do Socket.IO
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:8080', 'https://seu-frontend.com'],
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Tipos e Estado
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

const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

const gerarId = () => Math.random().toString(36).substring(2, 15);

// ===== ROTAS =====

// Gerar Senha
router.post('/gerar', async (req: Request, res: Response) => {
  try {
    const { tipo } = req.body;

    if (!tipo || !['O', 'L'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido. Use "O" ou "L".' });
    }

    state.contadores[tipo as TipoSenha] += 1;
    const novaSenha = `${tipo}${String(state.contadores[tipo as TipoSenha]).padStart(3, '0')}`;
    state.filaSenhas[tipo as TipoSenha].push(novaSenha);

    return res.json({
      senha: novaSenha,
      numero: state.contadores[tipo as TipoSenha],
      tipo
    });

  } catch (error) {
    console.error('Erro em /gerar:', error);
    return res.status(500).json({ error: 'Erro interno ao gerar senha' });
  }
});

// Chamar Senha
router.post('/chamar', (req: Request, res: Response) => {
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
    exameAtual: null
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

// Finalizar Atendimento
router.post('/finalizar-atendimento', (req: Request, res: Response) => {
  const { senha } = req.body;
  const chamada = state.senhasChamadas.find(s => s.senha === senha);
  if (!chamada) return res.status(404).json({ error: 'Senha não encontrada' });

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

// Marcar como em atendimento
router.post('/marcar-em-atendimento', (req: Request, res: Response) => {
  const { id } = req.body;
  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) return res.status(404).json({ error: 'Chamada não encontrada' });

  chamada.emAtendimento = false;
  chamada.exameAtual = null;

  io.emit('atualizacao-atendimento', {
    id: chamada.id,
    emAtendimento: false,
    exameAtual: null,
  });

  return res.json({ sucesso: true, chamada });
});

// Confirmar exames
router.post('/confirmar-exames', async (req: Request, res: Response) => {
  try {
    const { senha, guiche, exames, action, id }: ExamePayload = req.body;

    if (!senha || !guiche || !Array.isArray(exames)) {
      return res.status(400).json({ sucesso: false, mensagem: 'Dados inválidos' });
    }

    if (action === 'editar' && !id) {
      return res.status(400).json({ sucesso: false, mensagem: 'ID é obrigatório para editar' });
    }

    let chamada = state.senhasChamadas.find(s => 
      action === 'editar' ? s.id === id : s.senha === senha && s.guiche === guiche
    );

    if (!chamada) return res.status(404).json({ sucesso: false, mensagem: 'Senha não encontrada' });

    chamada.exames = [...new Set(exames)];

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

  } catch (error) {
    console.error('Erro em confirmar-exames:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro interno' });
  }
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log('Cliente conectado');

  socket.emit('estado-inicial', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas.filter(s => !s.finalizado).slice(-5).reverse()
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// ===== Middleware e Inicialização =====
app.use('/api', router);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Configuração de impressora USB: ${PRINTER_PATH}`);
});
