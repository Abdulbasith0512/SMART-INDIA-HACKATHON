export const mockDoctors = [
  {
    id: 1,
    name: "Dr. Sarah Johnson",
    specialization: "Cardiologist",
    experience: "15 years",
    rating: 4.9,
    image: "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=300&h=300&fit=crop&crop=face",
    availability: "Available",
    consultationFee: "$150",
    education: "Harvard Medical School",
    languages: ["English", "Spanish"]
  },
  {
    id: 2,
    name: "Dr. Michael Chen",
    specialization: "Neurologist",
    experience: "12 years",
    rating: 4.8,
    image: "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=300&h=300&fit=crop&crop=face",
    availability: "Available",
    consultationFee: "$180",
    education: "Johns Hopkins University",
    languages: ["English", "Mandarin"]
  },
  {
    id: 3,
    name: "Dr. Emily Rodriguez",
    specialization: "Pediatrician",
    experience: "10 years",
    rating: 4.9,
    image: "https://images.unsplash.com/photo-1594824388748-d7115d0d8ce1?w=300&h=300&fit=crop&crop=face",
    availability: "Busy",
    consultationFee: "$120",
    education: "Stanford Medical School",
    languages: ["English", "Spanish", "French"]
  },
  {
    id: 4,
    name: "Dr. James Wilson",
    specialization: "Orthopedic Surgeon",
    experience: "18 years",
    rating: 4.7,
    image: "https://images.unsplash.com/photo-1582750433449-648ed127bb54?w=300&h=300&fit=crop&crop=face",
    availability: "Available",
    consultationFee: "$200",
    education: "Mayo Clinic Medical School",
    languages: ["English"]
  },
  {
    id: 5,
    name: "Dr. Lisa Thompson",
    specialization: "Dermatologist",
    experience: "8 years",
    rating: 4.8,
    image: "https://images.unsplash.com/photo-1543228806-8b0c8dd31bdb?w=300&h=300&fit=crop&crop=face",
    availability: "Available",
    consultationFee: "$130",
    education: "UCLA Medical Center",
    languages: ["English", "German"]
  },
  {
    id: 6,
    name: "Dr. Robert Kumar",
    specialization: "Psychiatrist",
    experience: "14 years",
    rating: 4.9,
    image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&h=300&fit=crop&crop=face",
    availability: "Available",
    consultationFee: "$160",
    education: "Columbia University",
    languages: ["English", "Hindi", "Gujarati"]
  }
];

export const mockPatients = [
  {
    id: 1,
    name: "John Smith",
    age: 45,
    gender: "Male",
    phone: "+1 (555) 123-4567",
    email: "john.smith@email.com",
    lastVisit: "2024-01-15",
    condition: "Hypertension",
    status: "Active"
  },
  {
    id: 2,
    name: "Maria Garcia",
    age: 32,
    gender: "Female",
    phone: "+1 (555) 234-5678",
    email: "maria.garcia@email.com",
    lastVisit: "2024-01-18",
    condition: "Diabetes Type 2",
    status: "Active"
  },
  {
    id: 3,
    name: "David Johnson",
    age: 28,
    gender: "Male",
    phone: "+1 (555) 345-6789",
    email: "david.johnson@email.com",
    lastVisit: "2024-01-20",
    condition: "Anxiety",
    status: "Follow-up"
  },
  {
    id: 4,
    name: "Sarah Williams",
    age: 55,
    gender: "Female",
    phone: "+1 (555) 456-7890",
    email: "sarah.williams@email.com",
    lastVisit: "2024-01-12",
    condition: "Arthritis",
    status: "Active"
  }
];

export const mockUsers = [
  {
    id: 1,
    name: "Alice Cooper",
    email: "alice.cooper@email.com",
    role: "Patient",
    joinDate: "2023-06-15",
    status: "Active"
  },
  {
    id: 2,
    name: "Bob Wilson",
    email: "bob.wilson@email.com",
    role: "Patient",
    joinDate: "2023-08-22",
    status: "Active"
  },
  {
    id: 3,
    name: "Carol Davis",
    email: "carol.davis@email.com",
    role: "Patient",
    joinDate: "2023-09-10",
    status: "Inactive"
  },
  {
    id: 4,
    name: "Daniel Brown",
    email: "daniel.brown@email.com",
    role: "Patient",
    joinDate: "2023-11-05",
    status: "Active"
  }
];

export const mockAppointments = [
  {
    id: 1,
    patientName: "John Smith",
    doctorName: "Dr. Sarah Johnson",
    date: "2024-01-25",
    time: "10:00 AM",
    type: "Consultation",
    status: "Confirmed"
  },
  {
    id: 2,
    patientName: "Maria Garcia",
    doctorName: "Dr. Michael Chen",
    date: "2024-01-26",
    time: "2:30 PM",
    type: "Follow-up",
    status: "Pending"
  },
  {
    id: 3,
    patientName: "David Johnson",
    doctorName: "Dr. Robert Kumar",
    date: "2024-01-27",
    time: "11:15 AM",
    type: "Therapy Session",
    status: "Confirmed"
  }
];

export const mockMessages = [
  {
    id: 1,
    sender: "Dr. Sarah Johnson",
    message: "Hello! How are you feeling today?",
    timestamp: new Date("2024-01-23T10:30:00"),
    isDoctor: true
  },
  {
    id: 2,
    sender: "You",
    message: "Hi Doctor, I'm feeling much better after taking the medication.",
    timestamp: new Date("2024-01-23T10:32:00"),
    isDoctor: false
  },
  {
    id: 3,
    sender: "Dr. Sarah Johnson",
    message: "That's wonderful to hear! Please continue with the current dosage and let me know if you experience any side effects.",
    timestamp: new Date("2024-01-23T10:35:00"),
    isDoctor: true
  },
  {
    id: 4,
    sender: "You",
    message: "Sure, I will. When should I schedule my next appointment?",
    timestamp: new Date("2024-01-23T10:37:00"),
    isDoctor: false
  },
  {
    id: 5,
    sender: "Dr. Sarah Johnson",
    message: "Let's schedule it for next week. I'll have my assistant coordinate with you for the best time.",
    timestamp: new Date("2024-01-23T10:40:00"),
    isDoctor: true
  }
];