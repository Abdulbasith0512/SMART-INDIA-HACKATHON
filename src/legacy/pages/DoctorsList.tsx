import { motion } from 'framer-motion';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Star, MapPin, Calendar, Search, Filter, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/client';
import { Skeleton } from '@/components/ui/skeleton';

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
import { useNavigate } from 'react-router-dom';

export default function DoctorsList() {
  const navigate = useNavigate();
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [specialtyFilter, setSpecialtyFilter] = useState('');
  const [availabilityFilter, setAvailabilityFilter] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

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

  const filteredDoctors = doctors.filter(doctor => {
    const name = (doctor.name || '').toLowerCase();
    const specialty = doctor.doctor_details?.[0]?.specialization?.toLowerCase() || '';
    const rating = doctor.doctor_details?.[0]?.rating || 4.5;
    
    // Search filter
    const matchesSearch = name.includes(searchTerm.toLowerCase()) || specialty.includes(searchTerm.toLowerCase());
    
    // Specialty filter
    const matchesSpecialty = !specialtyFilter || specialty.includes(specialtyFilter.toLowerCase());
    
    // Rating filter
    const matchesRating = !ratingFilter || rating >= parseFloat(ratingFilter);
    
    // Availability filter (simulated - in real app would check actual availability)
    const matchesAvailability = !availabilityFilter || 
      (availabilityFilter === 'today' && Math.random() > 0.3) ||
      (availabilityFilter === 'week' && Math.random() > 0.1) ||
      (availabilityFilter === 'month');
    
    return matchesSearch && matchesSpecialty && matchesRating && matchesAvailability;
  });

  return (
    <DashboardLayout userType="user">
      <div className="space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
        >
          <div>
            <h1 className="text-3xl font-bold">Find Your Doctor</h1>
            <p className="text-muted-foreground">Browse through our verified healthcare professionals</p>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  placeholder="Search doctors by name or specialization..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Button 
                variant="outline" 
                className="flex items-center gap-2"
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4" />
                Filter
              </Button>
            </div>
            
            {showFilters && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="flex flex-col sm:flex-row gap-4 p-4 bg-muted/50 rounded-lg"
              >
                <div className="flex-1">
                  <label className="text-sm font-medium mb-2 block">Specialty</label>
                  <Select value={specialtyFilter} onValueChange={setSpecialtyFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Specialties" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All Specialties</SelectItem>
                      <SelectItem value="cardiology">Cardiology</SelectItem>
                      <SelectItem value="dermatology">Dermatology</SelectItem>
                      <SelectItem value="neurology">Neurology</SelectItem>
                      <SelectItem value="orthopedics">Orthopedics</SelectItem>
                      <SelectItem value="pediatrics">Pediatrics</SelectItem>
                      <SelectItem value="psychiatry">Psychiatry</SelectItem>
                      <SelectItem value="general">General Medicine</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="flex-1">
                  <label className="text-sm font-medium mb-2 block">Availability</label>
                  <Select value={availabilityFilter} onValueChange={setAvailabilityFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="Any Time" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Any Time</SelectItem>
                      <SelectItem value="today">Available Today</SelectItem>
                      <SelectItem value="week">This Week</SelectItem>
                      <SelectItem value="month">This Month</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="flex-1">
                  <label className="text-sm font-medium mb-2 block">Minimum Rating</label>
                  <Select value={ratingFilter} onValueChange={setRatingFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="Any Rating" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Any Rating</SelectItem>
                      <SelectItem value="4.5">4.5+ Stars</SelectItem>
                      <SelectItem value="4.0">4.0+ Stars</SelectItem>
                      <SelectItem value="3.5">3.5+ Stars</SelectItem>
                      <SelectItem value="3.0">3.0+ Stars</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="flex items-end">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      setSpecialtyFilter('');
                      setAvailabilityFilter('');
                      setRatingFilter('');
                    }}
                    className="flex items-center gap-2"
                  >
                    <X className="h-4 w-4" />
                    Clear
                  </Button>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"
        >
          {loading ? (
            // Loading skeletons
            Array(6).fill(0).map((_, index) => (
              <Card key={index} className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth group">
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <Skeleton className="h-12 w-12 rounded-full" />
                      <div>
                        <Skeleton className="h-5 w-32 mb-2" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    </div>
                    <Skeleton className="h-6 w-16" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-10 w-full" />
                </CardContent>
              </Card>
            ))
          ) : filteredDoctors.length === 0 ? (
            <div className="col-span-3 text-center py-10">
              <p className="text-muted-foreground">No doctors found matching your search criteria.</p>
            </div>
          ) : (
            filteredDoctors.map((doctor, index) => (
              <motion.div
                key={doctor.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + index * 0.1 }}
              >
                <Card className="glass-card border-glass-border hover:shadow-glow-primary transition-smooth group">
                  <CardHeader className="pb-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="text-4xl">{doctor.id % 2 === 0 ? '👨‍⚕️' : '👩‍⚕️'}</div>
                        <div>
                          <CardTitle className="text-lg">Dr. {doctor.name}</CardTitle>
                          <p className="text-sm text-muted-foreground">{doctor.doctor_details?.[0]?.specialization || 'Specialist'}</p>
                        </div>
                      </div>
                      <Badge variant="secondary" className="glass">
                        {doctor.doctor_details?.[0]?.experience !== null && doctor.doctor_details?.[0]?.experience !== undefined ? `${doctor.doctor_details[0].experience} years` : 'Experience not specified'}
                      </Badge>
                    </div>
                  </CardHeader>
                  
                  <CardContent className="space-y-4">
                    <div className="flex items-center text-sm">
                      <div className="flex items-center space-x-1">
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                        <span className="font-medium">{(doctor.doctor_details?.[0]?.rating || 4.5).toFixed(1)}</span>
                        <span className="text-muted-foreground">({doctor.doctor_details?.[0]?.reviews || 'No reviews yet'})</span>
                      </div>
                    </div>
                    
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center space-x-2 text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        <span>{doctor.doctor_details?.[0]?.location || 'Remote Available'}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-healthcare-green" />
                        <span className="text-healthcare-green">
                          {doctor.doctor_details?.[0]?.availability || 'Available today'}
                        </span>
                      </div>
                    </div>
                    
                    <Button 
                      className="w-full group-hover:shadow-glow-primary" 
                      variant="hero"
                      onClick={() => navigate('/book-appointment', { 
                        state: { 
                          doctorId: doctor.id,
                          doctorName: doctor.name,
                          specialization: doctor.doctor_details?.[0]?.specialization || 'Specialist'
                        } 
                      })}
                    >
                      <Calendar className="mr-2 h-4 w-4" />
                      Book Appointment
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))
          )}
        </motion.div>
      </div>
    </DashboardLayout>
  );
}