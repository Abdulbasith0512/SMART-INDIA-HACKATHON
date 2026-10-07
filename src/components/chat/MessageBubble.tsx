import { motion } from 'framer-motion';

interface MessageBubbleProps {
  message: string;
  timestamp: string;
  isOwnMessage: boolean;
  senderName?: string;
}

export const MessageBubble = ({ message, timestamp, isOwnMessage, senderName }: MessageBubbleProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'} mb-4`}
    >
      <div
        className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
          isOwnMessage
            ? 'bg-blue-500 text-white rounded-br-none'
            : 'bg-gray-200 text-gray-800 rounded-bl-none'
        }`}
      >
        {!isOwnMessage && senderName && (
          <p className="text-xs font-semibold mb-1 text-gray-600">{senderName}</p>
        )}
        <p className="text-sm">{message}</p>
        <p className={`text-xs mt-1 ${isOwnMessage ? 'text-blue-100' : 'text-gray-500'}`}>
          {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </motion.div>
  );
};