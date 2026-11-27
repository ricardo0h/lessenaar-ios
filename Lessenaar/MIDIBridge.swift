import CoreMIDI
import Foundation

/// Een MIDI-bron of -bestemming zoals de polyfill hem als Web MIDI-input of -output toont.
struct MIDISource: Encodable {
    let id: Int32
    let name: String
    let manufacturer: String
}

/// CoreMIDI ↔ de webpagina. Luistert naar alle bronnen en kan naar de bestemmingen sturen (MIDI-uit); start pas als de
/// pagina om MIDI vraagt. Callbacks komen op de main thread.
final class MIDIBridge {
    /// bronnen, bestemmingen
    var onSources: (([MIDISource], [MIDISource]) -> Void)?
    /// bron-id, ruwe pakketbytes, host-tijd van het pakket (mach_absolute_time)
    var onPacket: ((Int32, [UInt8], UInt64) -> Void)?

    private(set) var sources: [MIDISource] = []
    private(set) var destinations: [MIDISource] = []
    private(set) var error: String?
    private var client = MIDIClientRef()
    private var inPort = MIDIPortRef()
    private var outPort = MIDIPortRef()
    private var connected: [MIDIEndpointRef] = []
    private var destinationRefs: [Int32: MIDIEndpointRef] = [:]
    private var sentAny = false   // pas noten uitzetten als er ooit iets verstuurd is
    private(set) var started = false

    func start() {
        if started { onSources?(sources, destinations); return }
        started = true
        var status = MIDIClientCreateWithBlock("Lessenaar" as CFString, &client) { [weak self] note in
            guard note.pointee.messageID == .msgSetupChanged else { return }
            DispatchQueue.main.async { self?.reconnect() }
        }
        guard status == noErr else { error = "MIDIClientCreate \(status)"; onSources?([], []); return }
        status = MIDIInputPortCreateWithBlock(client, "Lessenaar in" as CFString, &inPort) { [weak self] list, refCon in
            let id = Int32(truncatingIfNeeded: Int(bitPattern: refCon))
            var packets: [([UInt8], UInt64)] = []
            for packet in list.unsafeSequence() {
                let length = Int(packet.pointee.length)
                guard length > 0 else { continue }
                let raw = UnsafeRawPointer(packet) + MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data)!
                let bytes = [UInt8](UnsafeRawBufferPointer(start: raw, count: length))
                let stamp = packet.pointee.timeStamp
                packets.append((bytes, stamp == 0 ? mach_absolute_time() : stamp))
            }
            DispatchQueue.main.async {
                guard let self else { return }
                for (bytes, stamp) in packets { self.onPacket?(id, bytes, stamp) }
            }
        }
        guard status == noErr else { error = "MIDIInputPortCreate \(status)"; onSources?([], []); return }
        status = MIDIOutputPortCreate(client, "Lessenaar uit" as CFString, &outPort)
        if status != noErr { error = "MIDIOutputPortCreate \(status)"; outPort = 0 }   // invoer werkt dan nog wel
        reconnect()
    }

    /// Bytes naar een bestemming (de pagina heeft ze al gecontroleerd: volledige berichten, geen sysex).
    /// `delayMs` > 0: CoreMIDI speelt ze op dat moment af (tijdstempel in host-tijd), anders meteen.
    /// Berichten gaan in de volgorde van aanroepen naar CoreMIDI; dat plant ze op hun tijdstempel in.
    @discardableResult
    func send(to id: Int32, bytes: [UInt8], delayMs: Double) -> Bool {
        guard outPort != 0, let destination = destinationRefs[id], !bytes.isEmpty, bytes.count <= 65_000 else { return false }
        let stamp: MIDITimeStamp = delayMs > 0 ? mach_absolute_time() + Self.ticks(milliseconds: delayMs) : 0
        let size = MemoryLayout<MIDIPacketList>.size + bytes.count
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<MIDIPacketList>.alignment)
        defer { buffer.deallocate() }
        let list = buffer.bindMemory(to: MIDIPacketList.self, capacity: 1)
        let first = MIDIPacketListInit(list)
        let added: UnsafeMutablePointer<MIDIPacket>? = bytes.withUnsafeBufferPointer { data in
            MIDIPacketListAdd(list, size, first, stamp, data.count, data.baseAddress!)
        }
        guard added != nil else { return false }
        sentAny = true
        return MIDISend(outPort, destination, list) == noErr
    }

    /// Wat nog ingepland staat voor deze bestemming niet meer afspelen (Web MIDI: MIDIOutput.clear()).
    func clear(_ id: Int32) {
        guard let destination = destinationRefs[id] else { return }
        MIDIFlushOutput(destination)
    }

    /// Alles wat nog ingepland staat niet meer afspelen, en alle noten uit (de pagina is weg of herladen).
    func stopAll() {
        guard outPort != 0, sentAny else { return }
        for (id, destination) in destinationRefs {
            MIDIFlushOutput(destination)
            for channel: UInt8 in 0..<16 { send(to: id, bytes: [0xB0 | channel, 123, 0], delayMs: 0) }   // All Notes Off
        }
        sentAny = false
    }

    static func ticks(milliseconds: Double) -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return UInt64(milliseconds * 1_000_000 * Double(info.denom) / Double(info.numer))
    }

    /// Opnieuw verbinden met alle bronnen (bij start en bij elke wijziging: kabel eruit of erin).
    private func reconnect() {
        for endpoint in connected { MIDIPortDisconnectSource(inPort, endpoint) }
        connected = []
        var found: [MIDISource] = []
        var endpoints: [MIDIEndpointRef] = []
        for index in 0..<MIDIGetNumberOfSources() {
            let endpoint = MIDIGetSource(index)
            if endpoint != 0 { endpoints.append(endpoint) }
        }
        // Is er een echt instrument (USB of Bluetooth), dan alleen dat: de netwerksessie van iOS en de virtuele poorten
        // van andere apps (zoals MIDIWeb Out) staan anders vooraan en de app noemt dan de verkeerde bron als piano.
        let hardware = endpoints.filter(Self.isHardware)
        for endpoint in hardware.isEmpty ? endpoints : hardware {
            var uid: Int32 = 0
            MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &uid)
            let name = Self.string(endpoint, kMIDIPropertyDisplayName) ?? Self.string(endpoint, kMIDIPropertyName) ?? "MIDI"
            let maker = Self.string(endpoint, kMIDIPropertyManufacturer) ?? ""
            let refCon = UnsafeMutableRawPointer(bitPattern: Int(uid))
            if MIDIPortConnectSource(inPort, endpoint, refCon) == noErr {
                connected.append(endpoint)
                found.append(MIDISource(id: uid, name: name, manufacturer: maker))
            }
        }
        sources = found

        // Bestemmingen (MIDI-uit) met dezelfde voorkeur: een echt instrument gaat voor.
        var outs: [MIDIEndpointRef] = []
        for index in 0..<MIDIGetNumberOfDestinations() {
            let endpoint = MIDIGetDestination(index)
            if endpoint != 0 { outs.append(endpoint) }
        }
        let hardwareOuts = outs.filter(Self.isHardware)
        var refs: [Int32: MIDIEndpointRef] = [:]
        var foundOuts: [MIDISource] = []
        for endpoint in hardwareOuts.isEmpty ? outs : hardwareOuts {
            let info = Self.describe(endpoint)
            refs[info.id] = endpoint
            foundOuts.append(info)
        }
        destinationRefs = refs
        destinations = foundOuts
        onSources?(found, foundOuts)
    }

    private static func describe(_ endpoint: MIDIEndpointRef) -> MIDISource {
        var uid: Int32 = 0
        MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &uid)
        let name = string(endpoint, kMIDIPropertyDisplayName) ?? string(endpoint, kMIDIPropertyName) ?? "MIDI"
        let maker = string(endpoint, kMIDIPropertyManufacturer) ?? ""
        return MIDISource(id: uid, name: name, manufacturer: maker)
    }

    /// Een bron of bestemming van een aangesloten apparaat: hoort bij een entity (virtuele poorten van apps niet) en komt niet van de
    /// netwerkdriver van iOS.
    private static func isHardware(_ endpoint: MIDIEndpointRef) -> Bool {
        var entity = MIDIEntityRef()
        guard MIDIEndpointGetEntity(endpoint, &entity) == noErr, entity != 0 else { return false }
        var device = MIDIDeviceRef()
        guard MIDIEntityGetDevice(entity, &device) == noErr, device != 0 else { return false }
        let driver = string(device, kMIDIPropertyDriverOwner) ?? ""
        if driver.contains("RTP") { return false }   // com.apple.AppleMIDIRTPDriver
        // Vangnet als de driver anders heet: het apparaat van de netwerksessie heet "Network" (vertaald: "Netwerk").
        let deviceName = (string(device, kMIDIPropertyName) ?? "").lowercased()
        return !(deviceName == "network" || deviceName == "netwerk")
    }

    private static func string(_ object: MIDIObjectRef, _ property: CFString) -> String? {
        var value: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(object, property, &value) == noErr, let text = value?.takeRetainedValue() else {
            return nil
        }
        return text as String
    }
}
