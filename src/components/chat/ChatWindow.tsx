import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';

interface Message {
  id: number;
  sender_id: number;
  receiver_id: number;
  message: string;
  timestamp: string;
  sender?: { id: number; name: string };
  receiver?: { id: number; name: string };
}

interface ChatWindowProps {
  messages: Message[];
  currentUserId: number;
  onSendMessage: (message: string) => void;
  isLoading?: boolean;
}

export const ChatWindow = ({ 
  messages, 
  currentUserId, 
  onSendMessage, 
  isLoading = false
}: ChatWindowProps) => {
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [messages]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
          <p className="text-gray-500">Loading messages...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Messages Area */}
      <ScrollArea ref={scrollAreaRef} className="flex-1 p-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-gray-500 mb-2">No messages yet</p>
              <p className="text-sm text-gray-400">Start the conversation!</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message.message}
                timestamp={message.timestamp}
                isOwnMessage={message.sender_id === currentUserId}
                senderName={message.sender?.name}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Message Input */}
      <MessageInput 
        onSendMessage={onSendMessage}
        placeholder="Type your message..."
      />
    </div>
  );
};