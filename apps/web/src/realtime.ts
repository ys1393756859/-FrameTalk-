import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function onEvent(handler: (evt: any) => void): () => void {
  const s = getSocket();
  s.on('event', handler);
  return () => s.off('event', handler);
}

export function joinProject(projectId: string) {
  getSocket().emit('join-project', projectId);
}
