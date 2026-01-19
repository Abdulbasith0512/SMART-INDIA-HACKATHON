import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
// ThreeBackground removed to fix WebGLRenderer context lost error
import { FloatingIcons } from '@/components/FloatingIcons';
import { Shield, Heart, Users, Award, Clock, Globe } from 'lucide-react';

const features = [
  {
    icon: Shield,
    title: "Secure & Private",
    description: "Your health data is protected with military-grade encryption and HIPAA compliance."
  },
  {
    icon: Heart,
    title: "Patient-Centered Care",
    description: "Every feature is designed with your health and convenience as our top priority."
  },
  {
    icon: Users,
    title: "Verified Professionals",
    description: "All doctors are thoroughly vetted and certified healthcare professionals."
  },
  {
    icon: Award,
    title: "Quality Assurance",
    description: "We maintain the highest standards of medical care and service excellence."
  },
  {
    icon: Clock,
    title: "24/7 Availability",
    description: "Access healthcare services anytime, anywhere with our round-the-clock platform."
  },
  {
    icon: Globe,
    title: "Global Reach",
    description: "Connecting patients with healthcare professionals across multiple locations."
  }
];

export default function About() {
  return (
    <div className="min-h-screen">

      <FloatingIcons />
      <Header />
      
      <section className="pt-32 pb-20 px-4">
        <div className="container mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="max-w-4xl mx-auto text-center mb-16"
          >
            <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-healthcare bg-clip-text text-transparent">
              About MediCare
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed">
              We're revolutionizing healthcare by making quality medical care accessible, 
              convenient, and secure for everyone, everywhere.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-20"
          >
            {features.map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + index * 0.1 }}
              >
                <Card className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth h-full">
                  <CardContent className="p-6 text-center">
                    <div className="p-4 rounded-full bg-gradient-primary w-20 h-20 mx-auto mb-4">
                      <feature.icon className="h-12 w-12 text-primary-foreground" />
                    </div>
                    <h3 className="text-xl font-semibold mb-3">{feature.title}</h3>
                    <p className="text-muted-foreground">{feature.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="glass-card border-glass-border p-8 md:p-12 rounded-2xl text-center"
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Our Mission</h2>
            <p className="text-lg text-muted-foreground max-w-3xl mx-auto leading-relaxed">
              To bridge the gap between patients and healthcare providers through innovative technology, 
              ensuring that quality medical care is just a click away. We believe healthcare should be 
              accessible, transparent, and patient-focused.
            </p>
          </motion.div>
        </div>
      </section>
    </div>
  );
}