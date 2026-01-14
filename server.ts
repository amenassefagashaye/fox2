import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { WebSocket, isWebSocketCloseEvent } from "https://deno.land/std@0.168.0/ws/mod.ts";

// Types
interface Player {
  id: string;
  name: string;
  phone: string;
  stake: number;
  boardType: string;
  boardId: number;
  connected: boolean;
  socket: WebSocket;
  markedNumbers: number[];
  lastPing: number;
}

interface Admin {
  socket: WebSocket;
  authenticated: boolean;
}

interface GameState {
  status: 'waiting' | 'playing' | 'paused' | 'ended';
  calledNumbers: number[];
  currentNumber: number | null;
  autoCall: boolean;
  autoCallInterval: number | null;
  players: Map<string, Player>;
  winners: Array<{
    playerId: string;
    name: string;
    pattern: string;
    amount: number;
    time: Date;
  }>;
  finance: {
    totalIncome: number;
    totalPayout: number;
    currentBalance: number;
  };
}

// Game Server Class
class BingoServer {
  private gameState: GameState;
  private admin: Admin | null = null;
  private pingInterval: number;
  
  constructor() {
    this.gameState = {
      status: 'waiting',
      calledNumbers: [],
      currentNumber: null,
      autoCall: false,
      autoCallInterval: null,
      players: new Map(),
      winners: [],
      finance: {
        totalIncome: 0,
        totalPayout: 0,
        currentBalance: 0
      }
    };
    
    // Ping clients every 30 seconds
    this.pingInterval = setInterval(() => this.pingClients(), 30000);
  }
  
  // Handle HTTP requests
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    
    // Serve admin page
    if (url.pathname === '/admin') {
      const file = await Deno.readFile('./frontend/admin.html');
      return new Response(file, {
        headers: { 'content-type': 'text/html' }
      });
    }
    
    // Serve player page
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const file = await Deno.readFile('./frontend/index.html');
      return new Response(file, {
        headers: { 'content-type': 'text/html' }
      });
    }
    
    // Serve static files
    if (url.pathname.startsWith('/frontend/')) {
      try {
        const file = await Deno.readFile(`.${url.pathname}`);
        const contentType = this.getContentType(url.pathname);
        return new Response(file, {
          headers: { 'content-type': contentType }
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    
    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const { socket, response } = Deno.upgradeWebSocket(req);
      this.handleWebSocket(socket);
      return response;
    }
    
    return new Response('Not found', { status: 404 });
  }
  
  // Handle WebSocket connections
  handleWebSocket(socket: WebSocket) {
    console.log('New WebSocket connection');
    
    socket.onopen = () => {
      console.log('WebSocket opened');
    };
    
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(socket, data);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };
    
    socket.onclose = () => {
      console.log('WebSocket closed');
      this.handleDisconnect(socket);
    };
    
    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }
  
  // Handle incoming messages
  async handleMessage(socket: WebSocket, data: any) {
    switch (data.type) {
      case 'admin_auth':
        this.handleAdminAuth(socket, data.password);
        break;
        
      case 'player_connect':
        this.handlePlayerConnect(socket, data.playerId, data.playerName);
        break;
        
      case 'player_register':
        this.handlePlayerRegister(socket, data);
        break;
        
      case 'mark_number':
        this.handleMarkNumber(socket, data.playerId, data.number);
        break;
        
      case 'claim_win':
        this.handleClaimWin(socket, data);
        break;
        
      case 'start_game':
        this.handleStartGame();
        break;
        
      case 'pause_game':
        this.handlePauseGame();
        break;
        
      case 'end_game':
        this.handleEndGame();
        break;
        
      case 'call_number':
        this.callRandomNumber();
        break;
        
      case 'toggle_auto_call':
        this.toggleAutoCall(data.enabled);
        break;
        
      case 'clear_numbers':
        this.clearCalledNumbers();
        break;
        
      case 'ping':
        this.handlePing(socket, data.playerId);
        break;
    }
  }
  
  // Admin authentication
  handleAdminAuth(socket: WebSocket, password: string) {
    if (password === 'asse2123') {
      this.admin = { socket, authenticated: true };
      this.sendToSocket(socket, {
        type: 'auth_success',
        message: 'Admin authenticated successfully'
      });
      this.sendGameStateToAdmin();
      console.log('Admin authenticated');
    } else {
      this.sendToSocket(socket, {
        type: 'auth_failed',
        message: 'Invalid password'
      });
      socket.close();
    }
  }
  
  // Player connection
  handlePlayerConnect(socket: WebSocket, playerId: string, playerName: string) {
    let player = this.gameState.players.get(playerId);
    
    if (player) {
      // Reconnecting player
      player.socket = socket;
      player.connected = true;
      player.lastPing = Date.now();
    } else {
      // New player
      player = {
        id: playerId,
        name: playerName || 'Guest',
        phone: '',
        stake: 0,
        boardType: '75ball',
        boardId: Math.floor(Math.random() * 100) + 1,
        connected: true,
        socket,
        markedNumbers: [],
        lastPing: Date.now()
      };
      this.gameState.players.set(playerId, player);
    }
    
    // Send current game state to player
    this.sendToSocket(socket, {
      type: 'game_state',
      state: {
        status: this.gameState.status,
        calledNumbers: this.gameState.calledNumbers,
        currentNumber: this.gameState.currentNumber,
        autoCall: this.gameState.autoCall
      }
    });
    
    // Notify admin
    this.sendPlayersUpdateToAdmin();
  }
  
  // Player registration
  handlePlayerRegister(socket: WebSocket, data: any) {
    const player = this.gameState.players.get(data.playerId);
    if (player) {
      player.name = data.name;
      player.phone = data.phone;
      player.stake = data.stake;
      player.boardType = data.boardType;
      
      // Add to finance
      this.gameState.finance.totalIncome += data.stake;
      this.gameState.finance.currentBalance += data.stake;
      
      // Broadcast to admin
      this.sendPlayersUpdateToAdmin();
      this.sendFinanceUpdateToAdmin();
    }
  }
  
  // Mark number
  handleMarkNumber(socket: WebSocket, playerId: string, number: number) {
    const player = this.gameState.players.get(playerId);
    if (player && !player.markedNumbers.includes(number)) {
      player.markedNumbers.push(number);
    }
  }
  
  // Claim win
  handleClaimWin(socket: WebSocket, data: any) {
    if (this.gameState.status !== 'playing') {
      this.sendToSocket(socket, {
        type: 'error',
        message: 'Game is not active'
      });
      return;
    }
    
    const player = this.gameState.players.get(data.playerId);
    if (!player) return;
    
    // Check win pattern (simplified logic)
    const winPattern = this.checkWinPattern(player.markedNumbers, data.boardType);
    
    if (winPattern) {
      const winAmount = this.calculateWinAmount(player.stake);
      
      // Add to winners
      this.gameState.winners.push({
        playerId: player.id,
        name: player.name,
        pattern: winPattern,
        amount: winAmount,
        time: new Date()
      });
      
      // Update finance
      this.gameState.finance.totalPayout += winAmount;
      this.gameState.finance.currentBalance -= winAmount;
      
      // Broadcast win
      this.broadcastToAllPlayers({
        type: 'winner_declared',
        winner: {
          name: player.name,
          pattern: winPattern,
          amount: winAmount
        }
      });
      
      // Notify admin
      this.sendWinnersUpdateToAdmin();
      this.sendFinanceUpdateToAdmin();
    } else {
      this.sendToSocket(socket, {
        type: 'error',
        message: 'No winning pattern found'
      });
    }
  }
  
  // Start game
  handleStartGame() {
    if (this.gameState.status === 'waiting' || this.gameState.status === 'ended') {
      this.gameState.status = 'playing';
      this.gameState.calledNumbers = [];
      this.gameState.currentNumber = null;
      
      // Reset player marked numbers
      this.gameState.players.forEach(player => {
        player.markedNumbers = [];
      });
      
      this.broadcastToAllPlayers({
        type: 'game_started'
      });
      
      this.sendGameStateToAdmin();
    }
  }
  
  // Pause game
  handlePauseGame() {
    if (this.gameState.status === 'playing') {
      this.gameState.status = 'paused';
      this.sendGameStateToAdmin();
    } else if (this.gameState.status === 'paused') {
      this.gameState.status = 'playing';
      this.sendGameStateToAdmin();
    }
  }
  
  // End game
  handleEndGame() {
    this.gameState.status = 'ended';
    this.broadcastToAllPlayers({
      type: 'game_ended'
    });
    this.sendGameStateToAdmin();
  }
  
  // Call random number
  callRandomNumber() {
    if (this.gameState.status !== 'playing') return;
    
    let number: number;
    do {
      number = Math.floor(Math.random() * 75) + 1;
    } while (this.gameState.calledNumbers.includes(number));
    
    this.gameState.calledNumbers.push(number);
    this.gameState.currentNumber = number;
    
    // Broadcast to all players
    this.broadcastToAllPlayers({
      type: 'number_called',
      number: number
    });
    
    // Update admin
    this.sendCalledNumbersToAdmin();
  }
  
  // Toggle auto-call
  toggleAutoCall(enabled: boolean) {
    if (enabled && !this.gameState.autoCallInterval) {
      this.gameState.autoCall = true;
      this.gameState.autoCallInterval = setInterval(() => {
        this.callRandomNumber();
      }, 7000);
    } else if (!enabled && this.gameState.autoCallInterval) {
      this.gameState.autoCall = false;
      clearInterval(this.gameState.autoCallInterval);
      this.gameState.autoCallInterval = null;
    }
    
    this.sendGameStateToAdmin();
  }
  
  // Clear called numbers
  clearCalledNumbers() {
    this.gameState.calledNumbers = [];
    this.gameState.currentNumber = null;
    this.sendCalledNumbersToAdmin();
  }
  
  // Check win pattern (simplified)
  checkWinPattern(markedNumbers: number[], boardType: string): string | null {
    // Basic win check - at least 5 numbers in a row pattern
    if (markedNumbers.length >= 5) {
      if (boardType === '75ball' || boardType === '50ball') {
        return 'Row Win';
      } else if (boardType === '90ball') {
        return 'Line Win';
      } else if (boardType === 'pattern') {
        return 'Pattern Win';
      }
    }
    return null;
  }
  
  // Calculate win amount
  calculateWinAmount(stake: number): number {
    // 80% of total stakes from 90 players, minus 3% service fee
    const totalPot = 90 * stake * 0.8;
    return Math.floor(totalPot * 0.97);
  }
  
  // Handle ping
  handlePing(socket: WebSocket, playerId: string) {
    const player = this.gameState.players.get(playerId);
    if (player) {
      player.lastPing = Date.now();
    }
    this.sendToSocket(socket, { type: 'pong' });
  }
  
  // Ping clients
  pingClients() {
    const now = Date.now();
    
    // Ping players
    this.gameState.players.forEach(player => {
      if (now - player.lastPing > 60000) { // 60 seconds timeout
        player.connected = false;
      } else if (player.connected) {
        this.sendToSocket(player.socket, { type: 'ping' });
      }
    });
    
    // Update admin
    this.sendPlayersUpdateToAdmin();
  }
  
  // Handle disconnect
  handleDisconnect(socket: WebSocket) {
    // Check if admin disconnected
    if (this.admin && this.admin.socket === socket) {
      this.admin = null;
      console.log('Admin disconnected');
      return;
    }
    
    // Find and mark player as disconnected
    for (const [id, player] of this.gameState.players) {
      if (player.socket === socket) {
        player.connected = false;
        this.sendPlayersUpdateToAdmin();
        break;
      }
    }
  }
  
  // Send to specific socket
  sendToSocket(socket: WebSocket, data: any) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }
  
  // Broadcast to all players
  broadcastToAllPlayers(data: any) {
    this.gameState.players.forEach(player => {
      if (player.connected) {
        this.sendToSocket(player.socket, data);
      }
    });
  }
  
  // Send game state to admin
  sendGameStateToAdmin() {
    if (this.admin && this.admin.authenticated) {
      this.sendToSocket(this.admin.socket, {
        type: 'game_state',
        state: {
          status: this.gameState.status,
          autoCall: this.gameState.autoCall,
          paused: this.gameState.status === 'paused'
        }
      });
    }
  }
  
  // Send players list to admin
  sendPlayersUpdateToAdmin() {
    if (this.admin && this.admin.authenticated) {
      const players = Array.from(this.gameState.players.values()).map(player => ({
        id: player.id,
        name: player.name,
        stake: player.stake,
        board: player.boardId,
        connected: player.connected
      }));
      
      this.sendToSocket(this.admin.socket, {
        type: 'players_update',
        players: players
      });
    }
  }
  
  // Send called numbers to admin
  sendCalledNumbersToAdmin() {
    if (this.admin && this.admin.authenticated) {
      this.sendToSocket(this.admin.socket, {
        type: 'called_numbers',
        numbers: this.gameState.calledNumbers
      });
    }
  }
  
  // Send winners to admin
  sendWinnersUpdateToAdmin() {
    if (this.admin && this.admin.authenticated) {
      this.sendToSocket(this.admin.socket, {
        type: 'winners_update',
        winners: this.gameState.winners.slice(-10) // Last 10 winners
      });
    }
  }
  
  // Send finance update to admin
  sendFinanceUpdateToAdmin() {
    if (this.admin && this.admin.authenticated) {
      this.sendToSocket(this.admin.socket, {
        type: 'finance_update',
        finance: this.gameState.finance
      });
    }
  }
  
  // Get content type for static files
  getContentType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'html': return 'text/html';
      case 'css': return 'text/css';
      case 'js': return 'application/javascript';
      case 'json': return 'application/json';
      case 'png': return 'image/png';
      case 'jpg': case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      default: return 'application/octet-stream';
    }
  }
}

// Create and run server
const bingoServer = new BingoServer();

serve((req) => bingoServer.handleRequest(req), {
  port: 8080
});

console.log('Bingo server running on http://localhost:8080');
console.log('Admin panel: http://localhost:8080/admin?admin=true');