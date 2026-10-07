import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Activity, ShieldCheck, Languages } from 'lucide-react';
import { FloatingIcons } from '@/components/FloatingIcons';

export default function Home() {
  return (
    <div className="min-h-screen pt-24 bg-gradient-to-br from-blue-50 to-indigo-100">
      <FloatingIcons />
      <section className="container mx-auto px-4 py-16 text-center">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <h1 className="text-4xl md:text-6xl font-bold mb-6 bg-gradient-healthcare bg-clip-text text-transparent">
            JanSanket
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto mb-4">
            Community health intelligence and response for public-health officers.
          </p>
          <p className="text-muted-foreground max-w-2xl mx-auto mb-8">
            Privacy-preserving community and facility signals, surfaced as potential emerging signals that
            require human verification.
          </p>
          <div className="flex justify-center gap-4">
            <Button asChild size="lg" variant="hero">
              <Link to="/signup">Create account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/about">Learn more</Link>
            </Button>
          </div>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 mt-16 text-left">
          {[
            { icon: Activity, title: 'Signals, not diagnoses', text: 'Aggregated, uncertainty-aware leads for verification.' },
            { icon: ShieldCheck, title: 'Privacy by design', text: 'Data minimisation and role-based access enforced in the database.' },
            { icon: Languages, title: 'English, Hindi, Odia', text: 'Built for multilingual community reporting.' },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="glass-card rounded-xl p-6 border border-glass-border">
              <Icon className="h-8 w-8 text-primary mb-3" />
              <h3 className="font-semibold mb-1">{title}</h3>
              <p className="text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
