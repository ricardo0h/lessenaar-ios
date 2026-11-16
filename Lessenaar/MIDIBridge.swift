import CoreMIDI
import Foundation

/// Een MIDI-bron zoals de polyfill hem als Web MIDI-input toont.
struct MIDISource: Encodable {
    let id: Int32
    let name: String
    let manufacturer: String
}

/// CoreMIDI → de webpagina. Luistert naar alle bronnen; start pas als de pagina om MIDI vraagt.
/// Callbacks komen op de main thread.
final class MIDIBridge {
    var onSources: (([MIDISource]) -> Void)?
    /// bron-id, ruwe pakketbytes, host-tijd van het pakket (mach_absolute_time)
    var onPacket: ((Int32, [UInt8], UInt64) -> Void)?

    private(set) var sources: [MIDISource] = []
    private(set) var error: String?
    private var client = MIDIClientRef()
    private var inPort = MIDIPortRef()
    private var connected: [MIDIEndpointRef] = []
    private var started = false

    func start() {
        if started { onSources?(sources); return }
        started = true
        var status = MIDIClientCreateWithBlock("Lessenaar" as CFString, &client) { [weak self] note in
            guard note.pointee.messageID == .msgSetupChanged else { return }
            DispatchQueue.main.async { self?.reconnect() }
        }
        guard status == noErr else { error = "MIDIClientCreate \(status)"; onSources?([]); return }
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
        guard status == noErr else { error = "MIDIInputPortCreate \(status)"; onSources?([]); return }
        reconnect()
    }

    /// Opnieuw verbinden met alle bronnen (bij start en bij elke wijziging: kabel eruit of erin).
    private func reconnect() {
        for endpoint in connected { MIDIPortDisconnectSource(inPort, endpoint) }
        connected = []
        var found: [MIDISource] = []
        for index in 0..<MIDIGetNumberOfSources() {
            let endpoint = MIDIGetSource(index)
            guard endpoint != 0 else { continue }
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
        onSources?(found)
    }

    private static func string(_ object: MIDIObjectRef, _ property: CFString) -> String? {
        var value: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(object, property, &value) == noErr, let text = value?.takeRetainedValue() else {
            return nil
        }
        return text as String
    }
}
