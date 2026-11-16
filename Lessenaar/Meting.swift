import Foundation
import SwiftUI

/// Meting voor criterium (a): van pakket in CoreMIDI tot de app het bericht heeft verwerkt, en gemiste pakketten.
/// De polyfill stuurt per pakket een ack terug nadat de luisteraars van de app gedraaid hebben.
final class Meting: ObservableObject {
    static let shared = Meting()

    @Published private(set) var latencies: [Double] = []   // ms, alleen pakketten met een aanslag
    @Published private(set) var notes = 0
    @Published private(set) var packets = 0
    @Published private(set) var missed = 0
    @Published var sources: [MIDISource] = []
    private(set) var since = Date()
    private var pending: [Int: UInt64] = [:]

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

    func sent(seq: Int, hostTime: UInt64) {
        pending[seq] = hostTime
        packets += 1
        expire()
    }

    func ack(seq: Int, notes count: Int) {
        guard let hostTime = pending.removeValue(forKey: seq) else { return }
        notes += count
        if count > 0 {
            latencies.append(Self.ageMs(hostTime))
            if latencies.count > 20_000 { latencies.removeFirst(latencies.count - 20_000) }
        }
    }

    /// Pakketten zonder ack na 2 seconden tellen als gemist.
    func expire() {
        let limit = mach_absolute_time()
        let old = pending.filter { Self.milliseconds(limit > $0.value ? limit - $0.value : 0) > 2000 }
        for key in old.keys { pending.removeValue(forKey: key) }
        missed += old.count
    }

    /// De pagina is opnieuw geladen: openstaande pakketten komen nooit meer terug en tellen niet mee.
    func pageReloaded() { pending.removeAll() }

    func reset() {
        latencies = []; notes = 0; packets = 0; missed = 0; pending = [:]; since = Date()
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
        Aanslagen in de app: \(notes)
        Pakketten: \(packets), gemist: \(missed)
        Vertraging mediaan: \(ms(percentile(0.5)))
        Vertraging p95: \(ms(percentile(0.95)))
        Vertraging max: \(ms(latencies.max()))
        Bronnen: \(sources.isEmpty ? "geen" : sources.map(\.name).joined(separator: ", "))
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
                Text("Criterium (a): mediaan onder 20 ms en 0 gemist na 5 minuten spelen. Gemeten van het MIDI-pakket in iOS tot de app de noot heeft verwerkt.")
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
