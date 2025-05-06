import express from 'express';
import { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import net from 'net';
import dotenv from 'dotenv';

// Configuração de ambiente
dotenv.config();

const app = express();
const server = createServer(app);

// Configuração CORS
const corsOptions = {
  origin: [
    'http://localhost:8080',
    'https://seu-frontend.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Configuração do Socket.IO
const io = new Server(server, {
  cors: corsOptions,
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

// Estado da aplicação
const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

// Utilitários
const gerarId = () => Math.random().toString(36).substring(2, 15);

// Configuração da Impressora (opcional)
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.100';
const PRINTER_PORT = 9100;

// Função para gerar ZPL (opcional)
const gerarZPL = (senha: string, tipo: TipoSenha): string => {
  const numeroSenha = senha.replace(tipo, '');
  const dataHora = new Date();
  
  return `^XA
^CF0,40
^FO50,30^FDClinica Médica^FS
^FO50,80^FDSenha: ${tipo}${numeroSenha.padStart(3, '0')}^FS
^CF0,30
^FO50,130^FDTipo: ${tipo === 'O' ? 'OCUPACIONAL' : 'LABORATORIAL'}^FS
^FO50,170^FDData: ${dataHora.toLocaleDateString('pt-BR')}^FS
^FO50,210^FDHora: ${dataHora.toLocaleTimeString('pt-BR')}^FS
^XZ`;
};

// Função para imprimir na Zebra (opcional)
const imprimirNaZebra = async (zpl: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    
    client.connect(PRINTER_PORT, PRINTER_IP, () => {
      client.write(zpl, 'utf8', () => {
        client.destroy();
        resolve(true);
      });
    });

    client.on('error', (err) => {
      client.destroy();
      reject(err);
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Timeout de conexão com impressora'));
    });
  });
};

// Rotas Principais

// 1. Gerar Senha (Original)
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

// 2. Chamar Senha para Guichê (Original)
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

// 3. Finalizar Atendimento (Original)
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

// 4. Rotas para Consultório (Original)
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
    }

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

// 5. Nova Rota para Imprimir Senha (Adicionada)
app.post('/imprimir-senha', async (req: Request, res: Response) => {
  try {
    const { senha, tipo } = req.body;

    if (!senha || !tipo) {
      return res.status(400).json({ error: 'Parâmetros "senha" e "tipo" são obrigatórios' });
    }

    const zpl = gerarZPL(senha, tipo as TipoSenha);
    
    // Tentar imprimir (opcional - não quebra o fluxo se falhar)
    try {
      await imprimirNaZebra(zpl);
    } catch (err) {
      console.error('Erro ao imprimir (não crítico):', err);
    }

    res.json({ 
      success: true, 
      message: 'Senha processada com sucesso'
    });

  } catch (error) {
    console.error('Erro ao processar impressão:', error);
    res.status(500).json({ 
      error: 'Erro ao processar requisição',
      details: error instanceof Error ? error.message : 'Erro desconhecido'
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
});