import Foundation
import SwiftUI

/// Meting voor criterium (a): van het MIDI-pakket in iOS (tijdstempel van CoreMIDI) tot de app de noot heeft verwerkt.
/// De polyfill stuurt per pakket een ack terug nadat de luisteraars van de app gedraaid hebben. Alleen pakketten met een
/// aanslag tellen mee; active sensing (0xFE, ±3 per seconde van de ES520) niet.
final class Meting: ObservableObject {
    static let shared = Meting()

    @Published private(set) var latencies: [Double] = []   // ms, per pakket met een aanslag
    @Published private(set) var notesIOS = 0                // aanslagen die CoreMIDI binnenkreeg (na het laden van de pagina)
    @Published private(set) var notesApp = 0                // aanslagen die de app volgens de polyfill kreeg
    @Published private(set) var late = 0                    // aanslagen zonder antwoord binnen 2 s
    @Published var sources: [MIDISource] = []
    @Published var screenOn = false                         // de pagina houdt een wake lock vast (scherm blijft aan)
    private(set) var since = Date()
    private var pending: [Int: (hostTime: UInt64, notes: Int)] = [:]
    private var running: [Int32: UInt8] = [:]

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func milliseconds(_ ticks: UInt64) -> Double {
        Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000
    }

    static func ageMs(_ hostTime: UInt64) -> Double {
        let now = mach_absolute_time()
        return now > hostTime ? milliseconds(now - hostTime) : 0
    }

    private static func length(_ status: UInt8) -> Int {
        let high = status & 0xF0
        if high == 0xC0 || high == 0xD0 { return 2 }
        if status < 0xF0 { return 3 }
        if status == 0xF1 || status == 0xF3 { return 2 }
        if status == 0xF2 { return 3 }
        return 1
    }

    /// Aantal note-ons (velocity > 0) in een pakket; zelfde regels als splitMidi in de polyfill.
    static func noteOns(_ bytes: [UInt8], running: inout UInt8) -> Int {
        var count = 0, i = 0
        while i < bytes.count {
            let b = bytes[i]
            if b >= 0xF8 { i += 1; continue }
            if b == 0xF0 {
                while i < bytes.count && bytes[i] != 0xF7 { i += 1 }
                i += 1; running = 0; continue
            }
            let status: UInt8
            var j: Int
            if b >= 0x80 { status = b; j = i + 1; running = b < 0xF0 ? b : 0 }
            else if running != 0 { status = running; j = i }
            else { i += 1; continue }
            let need = length(status) - 1
            var data: [UInt8] = []
            while data.count < need && j < bytes.count && bytes[j] < 0x80 { data.append(bytes[j]); j += 1 }
            if data.count == need && status & 0xF0 == 0x90 && data[1] > 0 { count += 1 }
            i = j
        }
        return count
    }

    func sent(seq: Int, source: Int32, bytes: [UInt8], hostTime: UInt64) {
        var state = running[source] ?? 0
        let count = Self.noteOns(bytes, running: &state)
        running[source] = state
        if count > 0 {
            notesIOS += count
            pending[seq] = (hostTime, count)
        }
        expire()
    }

    func ack(seq: Int, notes count: Int) {
        notesApp += count
        guard let entry = pending.removeValue(forKey: seq), count > 0 else { return }
        latencies.append(Self.ageMs(entry.hostTime))
        if latencies.count > 20_000 { latencies.removeFirst(latencies.count - 20_000) }
    }

    /// Aanslagen zonder ack na 2 seconden tellen als te laat (of kwijt).
    func expire() {
        let now = mach_absolute_time()
        let old = pending.filter { Self.milliseconds(now > $0.value.hostTime ? now - $0.value.hostTime : 0) > 2000 }
        guard !old.isEmpty else { return }
        for key in old.keys { pending.removeValue(forKey: key) }
        late += old.values.reduce(0) { $0 + $1.notes }
    }

    /// De pagina is opnieuw geladen: openstaande pakketten komen nooit meer terug en tellen niet mee.
    /// Hun aanslagen gaan ook van de iOS-telling af, anders lijkt een herlaad op een gemiste noot.
    func pageReloaded() {
        notesIOS -= pending.values.reduce(0) { $0 + $1.notes }
        pending.removeAll(); running.removeAll()
    }

    func reset() {
        latencies = []; notesIOS = 0; notesApp = 0; late = 0; pending = [:]; since = Date()
    }

    func percentile(_ p: Double) -> Double? {
        guard !latencies.isEmpty else { return nil }
        let sorted = latencies.sorted()
        return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
    }

    var summary: String {
        let ms: (Double?) -> String = { $0.map { String(format: "%.1f ms", $0) } ?? "–" }
        let minutes = Int(Date().timeIntervalSince(since) / 60)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return """
        Lessenaar iOS-schil \(version) (\(build))
        Meting sinds \(minutes) min
        Aanslagen in iOS: \(notesIOS)
        Aanslagen in de app: \(notesApp)
        Te laat of kwijt (> 2 s): \(late)
        Vertraging mediaan: \(ms(percentile(0.5)))
        Vertraging p95: \(ms(percentile(0.95)))
        Vertraging max: \(ms(latencies.max()))
        Bronnen: \(sources.isEmpty ? "geen" : sources.map(\.name).joined(separator: ", "))
        Scherm blijft aan: \(screenOn ? "ja" : "nee")
        """
    }
}

/// Meetscherm: open met drie vingers lang op het scherm.
struct MetingView: View {
    @ObservedObject var meting = Meting.shared
    var close: () -> Void
    @State private var tick = 0
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(meting.summary)
                    .font(.system(.body, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .textSelection(.enabled)
                    .id(tick)
                Text("Criterium (a): mediaan onder 20 ms na 5 minuten spelen, aanslagen in iOS en in de app gelijk en 0 te laat. Gemeten van het MIDI-pakket in iOS tot de app de noot heeft verwerkt, inclusief de terugmelding; het tekenen op het scherm (tot ±16 ms) zit er niet in.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }
            .navigationTitle("Meting")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Sluiten", action: close) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Kopiëren") { meting.expire(); UIPasteboard.general.string = meting.summary }
                    Button("Opnieuw") { meting.reset() }
                }
            }
        }
        .onReceive(timer) { _ in meting.expire(); tick += 1 }
    }
}
