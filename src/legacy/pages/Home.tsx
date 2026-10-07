import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Calendar, Users, MessageCircle, Shield, Clock, Award, Star } from 'lucide-react';
// ThreeBackground removed to fix WebGLRenderer context lost error
import { FloatingIcons } from '@/components/FloatingIcons';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/client';
import { Avatar } from '@/components/ui/avatar';

// Local implementation of getDoctors
const getDoctors = async () => {
  const { data, error } = await supabase
    .from('users')
    .select(`
      *,
      doctor_details (
        specialization,
        qualification,
        experience,
        availability
      )
    `)
    .eq('role', 'doctor');

  if (error) {
    console.error('Error fetching doctors:', error);
    return [];
  }

  return data || [];
};
import { AvatarImage } from '@radix-ui/react-avatar';

const features = [
  {
    icon: Calendar,
    title: "Easy Scheduling",
    description: "Book appointments with your preferred doctors in just a few clicks"
  },
  {
    icon: Users,
    title: "Expert Doctors",
    description: "Connect with certified healthcare professionals across all specialties"
  },
  {
    icon: MessageCircle,
    title: "Instant Communication",
    description: "Chat directly with your doctors for quick consultations"
  },
  {
    icon: Shield,
    title: "Secure & Private",
    description: "Your health data is protected with end-to-end encryption"
  },
  {
    icon: Clock,
    title: "24/7 Available",
    description: "Access healthcare services anytime, anywhere"
  },
  {
    icon: Award,
    title: "Quality Care",
    description: "Receive the highest standard of medical care and attention"
  }
];

export default function Home() {
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDoctors = async () => {
      try {
        const doctorsData = await getDoctors();
        setDoctors(doctorsData || []);
      } catch (error) {
        console.error('Error fetching doctors:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchDoctors();
  }, []);

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1
      }
    }
  };

  const itemVariants = {
    hidden: { y: 20, opacity: 0 },
    visible: {
      y: 0,
      opacity: 1,
      transition: {
        duration: 0.5
      }
    }
  };

  return (
    <div className="min-h-screen">
      <FloatingIcons />
      
      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4">
        <div className="container mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="max-w-4xl mx-auto"
          >
            <h1 className="text-5xl md:text-7xl font-bold mb-6 bg-gradient-healthcare bg-clip-text text-transparent">
              Doctor Appointment
              <span className="block text-primary">Fixing System</span>
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground mb-8 leading-relaxed">
              Connect with trusted healthcare professionals and manage your health with ease. 
              Book appointments, chat with doctors, and take control of your wellness journey.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button asChild size="xl" variant="hero" className="animate-pulse-healthcare">
                <Link to="/login">
                  <Calendar className="mr-2 h-5 w-5" />
                  Book an Appointment
                </Link>
              </Button>
              <Button asChild size="xl" variant="glass-hero">
                <Link to="/about">Learn More</Link>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 px-4">
        <div className="container mx-auto">
          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <motion.h2 
              variants={itemVariants}
              className="text-3xl md:text-4xl font-bold mb-4"
            >
              Why Choose Our Platform?
            </motion.h2>
            <motion.p 
              variants={itemVariants}
              className="text-lg text-muted-foreground max-w-2xl mx-auto"
            >
              Experience healthcare like never before with our comprehensive appointment management system
            </motion.p>
          </motion.div>

          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="grid md:grid-cols-2 lg:grid-cols-3 gap-6"
          >
            {features.map((feature, index) => (
              <motion.div key={index} variants={itemVariants}>
                <Card className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth h-full group">
                  <CardContent className="p-6 text-center">
                    <div className="p-3 rounded-full bg-gradient-primary w-16 h-16 mx-auto mb-4 group-hover:shadow-glow-primary transition-smooth">
                      <feature.icon className="h-10 w-10 text-primary-foreground" />
                    </div>
                    <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
                    <p className="text-muted-foreground">{feature.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Featured Doctors Section */}
      <section className="py-20 px-4">
        <div className="container mx-auto">
          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <motion.h2 
              variants={itemVariants}
              className="text-3xl md:text-4xl font-bold mb-4"
            >
              Our Featured Doctors
            </motion.h2>
            <motion.p 
              variants={itemVariants}
              className="text-lg text-muted-foreground max-w-2xl mx-auto"
            >
              Connect with our top-rated healthcare professionals
            </motion.p>
          </motion.div>

          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="grid md:grid-cols-2 lg:grid-cols-3 gap-6"
          >
            {loading ? (
              // Loading state
              Array(3).fill(0).map((_, index) => (
                <motion.div key={index} variants={itemVariants}>
                  <Card className="glass-card border-glass-border h-full">
                    <CardContent className="p-6 flex flex-col items-center">
                      <div className="w-24 h-24 rounded-full bg-gray-200 animate-pulse mb-4"></div>
                      <div className="h-6 w-32 bg-gray-200 animate-pulse mb-2"></div>
                      <div className="h-4 w-24 bg-gray-200 animate-pulse mb-4"></div>
                      <div className="h-10 w-full bg-gray-200 animate-pulse"></div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            ) : (
              // Display doctors from Supabase
              doctors.slice(0, 3).map((doctor, index) => (
                <motion.div key={index} variants={itemVariants}>
                  <Card className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth h-full">
                    <CardContent className="p-6 flex flex-col items-center">
                      <Avatar className="w-24 h-24 mb-4">
                        <AvatarImage 
                          src={doctor.doctor_details?.[0]?.image_url || `https://randomuser.me/api/portraits/${index % 2 === 0 ? 'men' : 'women'}/${index + 1}.jpg`} 
                          alt={`Dr. ${doctor.first_name} ${doctor.last_name}`} 
                          className="object-cover"
                        />
                      </Avatar>
                      <h3 className="text-xl font-semibold mb-1">Dr. {doctor.first_name} {doctor.last_name}</h3>
                      <p className="text-muted-foreground mb-2">{doctor.doctor_details?.[0]?.specialization || 'Specialist'}</p>
                      <div className="flex items-center mb-4">
                        {Array(5).fill(0).map((_, i) => (
                          <Star key={i} className={`h-4 w-4 ${i < Math.floor(doctor.doctor_details?.[0]?.rating || 4.5) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}`} />
                        ))}
                        <span className="ml-2 text-sm">{doctor.doctor_details?.[0]?.rating || 4.5}</span>
                      </div>
                      <Button asChild className="w-full" variant="healthcare">
                        <Link to="/login">Book Appointment</Link>
                      </Button>
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            )}
          </motion.div>
          
          <div className="text-center mt-8">
            <Button asChild variant="outline">
              <Link to="/doctors">View All Doctors</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4">
        <div className="container mx-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="glass-card border-glass-border p-8 md:p-12 text-center rounded-2xl"
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Ready to Get Started?
            </h2>
            <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
              Join thousands of satisfied patients who trust our platform for their healthcare needs
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button asChild size="xl" variant="healthcare">
                <Link to="/signup">Create Account</Link>
              </Button>
              <Button asChild size="xl" variant="outline">
                <Link to="/contact">Contact Support</Link>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}