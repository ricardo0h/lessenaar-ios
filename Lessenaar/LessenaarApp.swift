import SwiftUI

@main
struct LessenaarApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea()
                .background(Color(red: 0x16 / 255, green: 0x18 / 255, blue: 0x1A / 255))
        }
    }
}
