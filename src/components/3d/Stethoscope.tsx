import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Mesh } from 'three';

export const Stethoscope = () => {
  const meshRef = useRef<Group>(null);
  const tubeRef1 = useRef<Mesh>(null);
  const tubeRef2 = useRef<Mesh>(null);

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.y = state.clock.elapsedTime * 0.2;
      meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3) * 0.05;
    }
  });

  return (
    <group ref={meshRef} scale={[2, 2, 2]} position={[0, 0, -3]}>
      {/* Main chest piece (bell/diaphragm) */}
      <mesh position={[0, -1.2, 0]}>
        <cylinderGeometry args={[0.4, 0.5, 0.15, 32]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.9} roughness={0.1} />
      </mesh>
      
      {/* Diaphragm surface */}
      <mesh position={[0, -1.12, 0]}>
        <cylinderGeometry args={[0.45, 0.45, 0.02, 32]} />
        <meshStandardMaterial color="#2c3e50" metalness={0.8} roughness={0.2} />
      </mesh>
      
      {/* Bell side (smaller end) */}
      <mesh position={[0, -1.28, 0]}>
        <cylinderGeometry args={[0.25, 0.25, 0.02, 32]} />
        <meshStandardMaterial color="#34495e" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Connecting stem */}
      <mesh position={[0, -0.8, 0]}>
        <cylinderGeometry args={[0.08, 0.12, 0.3, 16]} />
        <meshStandardMaterial color="#2c3e50" metalness={0.8} roughness={0.2} />
      </mesh>

      {/* Main tube split point */}
      <mesh position={[0, -0.5, 0]}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshStandardMaterial color="#34495e" metalness={0.7} roughness={0.3} />
      </mesh>
      
      {/* Left tube path - curved */}
      <group>
        {/* Left tube segment 1 */}
        <mesh position={[-0.3, -0.2, 0]} rotation={[0, 0, Math.PI / 6]}>
          <cylinderGeometry args={[0.025, 0.025, 0.8, 16]} />
          <meshStandardMaterial color="#0077B6" roughness={0.6} />
        </mesh>
        
        {/* Left tube segment 2 */}
        <mesh position={[-0.7, 0.3, 0]} rotation={[0, 0, Math.PI / 3]}>
          <cylinderGeometry args={[0.025, 0.025, 0.8, 16]} />
          <meshStandardMaterial color="#0077B6" roughness={0.6} />
        </mesh>
        
        {/* Left tube segment 3 */}
        <mesh position={[-1.0, 0.9, 0]} rotation={[0, 0, Math.PI / 2.5]}>
          <cylinderGeometry args={[0.025, 0.025, 0.5, 16]} />
          <meshStandardMaterial color="#0077B6" roughness={0.6} />
        </mesh>
      </group>

      {/* Right tube path - curved */}
      <group>
        {/* Right tube segment 1 */}
        <mesh position={[0.3, -0.2, 0]} rotation={[0, 0, -Math.PI / 6]}>
          <cylinderGeometry args={[0.025, 0.025, 0.8, 16]} />
          <meshStandardMaterial color="#0077B6" roughness={0.6} />
        </mesh>
        
        {/* Right tube segment 2 */}
        <mesh position={[0.7, 0.3, 0]} rotation={[0, 0, -Math.PI / 3]}>
          <cylinderGeometry args={[0.025, 0.025, 0.8, 16]} />
          <meshStandardMaterial color="#0077B6" roughness={0.6} />
        </mesh>
        
        {/* Right tube segment 3 */}
        <mesh position={[1.0, 0.9, 0]} rotation={[0, 0, -Math.PI / 2.5]}>
          <cylinderGeometry args={[0.025, 0.025, 0.5, 16]} />
          <meshStandardMaterial color="#0077B6" roughness={0.6} />
        </mesh>
      </group>
      
      {/* Left earpiece assembly */}
      <group position={[-1.3, 1.4, 0]}>
        {/* Earpiece tip */}
        <mesh position={[0, 0, 0]}>
          <coneGeometry args={[0.06, 0.15, 16]} />
          <meshStandardMaterial color="#2c3e50" metalness={0.8} roughness={0.2} />
        </mesh>
        {/* Earpiece base */}
        <mesh position={[0, -0.08, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.05, 16]} />
          <meshStandardMaterial color="#34495e" metalness={0.7} roughness={0.3} />
        </mesh>
      </group>
      
      {/* Right earpiece assembly */}
      <group position={[1.3, 1.4, 0]}>
        {/* Earpiece tip */}
        <mesh position={[0, 0, 0]}>
          <coneGeometry args={[0.06, 0.15, 16]} />
          <meshStandardMaterial color="#2c3e50" metalness={0.8} roughness={0.2} />
        </mesh>
        {/* Earpiece base */}
        <mesh position={[0, -0.08, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.05, 16]} />
          <meshStandardMaterial color="#34495e" metalness={0.7} roughness={0.3} />
        </mesh>
      </group>

      {/* Medical cross detail on chest piece */}
      <group position={[0, -1.11, 0]}>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.15, 0.03, 0.005]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.1} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.03, 0.15, 0.005]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.1} />
        </mesh>
      </group>
    </group>
  );
};