import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
// ThreeBackground removed to fix WebGLRenderer context lost error
import { FloatingIcons } from '@/components/FloatingIcons';
import { Mail, Phone, MapPin, Clock } from 'lucide-react';

const contactMethods = [
  {
    icon: Phone,
    title: "Phone Support",
    description: "Speak with our support team",
    value: "+1 (555) 123-4567",
    available: "24/7 Emergency Line"
  },
  {
    icon: Mail,
    title: "Email Support",
    description: "Send us your questions",
    value: "support@medicare.com",
    available: "Response within 2 hours"
  },
  {
    icon: MapPin,
    title: "Main Office",
    description: "Visit our headquarters",
    value: "123 Healthcare Ave, Medical District",
    available: "Mon-Fri: 9 AM - 6 PM"
  },
  {
    icon: Clock,
    title: "Live Chat",
    description: "Instant help available",
    value: "Available on website",
    available: "24/7 Online Support"
  }
];

export default function Contact() {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Form submission logic will be implemented later
    console.log('Contact form submitted');
  };

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
              Contact Us
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground leading-relaxed">
              We're here to help you with any questions or concerns about your healthcare journey.
            </p>
          </motion.div>

          <div className="grid lg:grid-cols-2 gap-12 max-w-6xl mx-auto">
            {/* Contact Methods */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
              className="space-y-6"
            >
              <h2 className="text-2xl font-bold mb-6">Get in Touch</h2>
              {contactMethods.map((method, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 + index * 0.1 }}
                >
                  <Card className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth">
                    <CardContent className="p-6">
                      <div className="flex items-start space-x-4">
                        <div className="p-3 rounded-full bg-gradient-primary">
                          <method.icon className="h-6 w-6 text-primary-foreground" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-semibold text-lg mb-1">{method.title}</h3>
                          <p className="text-muted-foreground text-sm mb-2">{method.description}</p>
                          <p className="font-medium text-primary">{method.value}</p>
                          <p className="text-sm text-healthcare-green">{method.available}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </motion.div>

            {/* Contact Form */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
            >
              <Card className="glass-card border-glass-border">
                <CardHeader>
                  <CardTitle className="text-2xl">Send us a Message</CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="firstName">First Name</Label>
                        <Input
                          id="firstName"
                          placeholder="John"
                          className="glass border-glass-border backdrop-blur-sm"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="lastName">Last Name</Label>
                        <Input
                          id="lastName"
                          placeholder="Doe"
                          className="glass border-glass-border backdrop-blur-sm"
                          required
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="john.doe@example.com"
                        className="glass border-glass-border backdrop-blur-sm"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="subject">Subject</Label>
                      <Input
                        id="subject"
                        placeholder="How can we help you?"
                        className="glass border-glass-border backdrop-blur-sm"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="message">Message</Label>
                      <Textarea
                        id="message"
                        placeholder="Tell us more about your inquiry..."
                        rows={5}
                        className="glass border-glass-border backdrop-blur-sm resize-none"
                        required
                      />
                    </div>

                    <Button type="submit" variant="hero" size="lg" className="w-full">
                      <Mail className="mr-2 h-4 w-4" />
                      Send Message
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </div>
      </section>
    </div>
  );
}