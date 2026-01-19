import { motion } from 'framer-motion';
import { Heart, Plus, Pill, Activity, Shield, Stethoscope } from 'lucide-react';

const icons = [
  { Icon: Heart, delay: 0, position: { top: '20%', left: '10%' } },
  { Icon: Plus, delay: 0.5, position: { top: '60%', left: '15%' } },
  { Icon: Pill, delay: 1, position: { top: '30%', right: '20%' } },
  { Icon: Activity, delay: 1.5, position: { top: '70%', right: '10%' } },
  { Icon: Shield, delay: 2, position: { top: '50%', left: '5%' } },
  { Icon: Stethoscope, delay: 2.5, position: { top: '40%', right: '30%' } },
];

export const FloatingIcons = () => {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden -z-5">
      {icons.map(({ Icon, delay, position }, index) => (
        <motion.div
          key={index}
          className="absolute opacity-10"
          style={position}
          initial={{ scale: 0, rotate: 0 }}
          animate={{ 
            scale: [0, 1, 0.8, 1],
            rotate: [0, 180, 360],
            y: [-20, 20, -20],
          }}
          transition={{
            duration: 8,
            delay,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        >
          <div className="p-3 rounded-full bg-gradient-healthcare/20 backdrop-blur-sm">
            <Icon className="h-8 w-8 text-primary" />
          </div>
        </motion.div>
      ))}
    </div>
  );
};