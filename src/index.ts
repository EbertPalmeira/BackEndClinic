import express from 'express';
import { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import dotenv from 'dotenv';

// Configuração de ambiente
dotenv.config();

const app = express();
const server = createServer(app);

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

// Estado da aplicação
const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

// Utilitários
const gerarId = () => Math.random().toString(36).substring(2, 15);



// 2. Gerar Senha (Original + impressão)
app.post('/gerar', async (req: Request, res: Response) => {
  try {
    const { tipo } = req.body;

    if (!tipo || !['O', 'L'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido. Use "O" ou "L".' });
    }

    state.contadores[tipo as TipoSenha] += 1;
    const novaSenha = `${tipo}${String(state.contadores[tipo as TipoSenha]).padStart(3, '0')}`;
    state.filaSenhas[tipo as TipoSenha].push(novaSenha);

    // Retorna a senha sem tentar imprimir
    return res.json({ 
      senha: novaSenha, 
      numero: state.contadores[tipo as TipoSenha], 
      tipo 
    });
    
  
  } catch (error) {
    console.error('Erro em /gerar:', error);
    return res.status(500).json({ 
      error: 'Erro interno ao gerar senha',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// 3. Chamar Senha para Guichê (Original)
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

// 4. Finalizar Atendimento (Original)
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
app.post('/marcar-em-atendimento', (req: Request, res: Response) => {
  const { id, exameAtual } = req.body;

  const chamada = state.senhasChamadas.find(s => s.id === id);
  if (!chamada) {
    return res.status(404).json({ error: 'Paciente não encontrado' });
  }

  chamada.emAtendimento = false;
  chamada.exameAtual = null;

  // Emitir atualização
  io.emit('atualizacao-atendimento', {
    id: chamada.id,
    emAtendimento: false,
    exameAtual: null,
  });

  return res.json({ sucesso: true, chamada });
});

// 5. Rotas para Consultório (Original)
app.post('/confirmar-exames', async (req: Request, res: Response) => {
  try {
    const { senha, guiche, exames, action, id }: ExamePayload = req.body;

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

    let chamada = state.senhasChamadas.find(s => 
      action === 'editar' ? s.id === id : s.senha === senha && s.guiche === guiche
    );

    if (!chamada) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Senha não encontrada'
      });
    }

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
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro interno no servidor'
    });
  }
});




// Socket.IO (Original)
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
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Inicialização do servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Configuração de impressora USB: ${PRINTER_PATH}`);
  console.log(`Teste de impressora disponível em: http://localhost:${PORT}/teste-impressora`);
});