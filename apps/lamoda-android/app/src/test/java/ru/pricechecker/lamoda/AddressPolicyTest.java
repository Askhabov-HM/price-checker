package ru.pricechecker.lamoda;
import org.junit.Test;
import static org.junit.Assert.*;
public class AddressPolicyTest {
    @Test public void invitationsAcceptOnlyTheFixedAppRouteAndSingleUseCapability() {
        String invitation = "0123456789abcdef0123456789abcdef";
        assertEquals("", AddressPolicy.invitation("pricechecker-lamoda://collect"));
        assertEquals(invitation, AddressPolicy.invitation("pricechecker-lamoda://collect?connect="+invitation));
        for (String value : new String[]{"https://collect?connect="+invitation, "pricechecker-lamoda://collect.evil?connect="+invitation,
                "pricechecker-lamoda://user@collect?connect="+invitation, "pricechecker-lamoda://collect/path?connect="+invitation,
                "pricechecker-lamoda://collect?connect=invalid", "pricechecker-lamoda://collect?connect="+invitation+"&server=https://other.example",
                "pricechecker-lamoda://collect?connect="+invitation+"#fragment", "pricechecker-lamoda://collect?connect="+invitation+"&connect="+invitation}) {
            assertThrows(IllegalArgumentException.class, () -> AddressPolicy.invitation(value));
        }
    }
    @Test public void serverRejectsCredentialedOrUnencryptedAddresses() {
        assertEquals("https://prices.example", AddressPolicy.server("https://prices.example/"));
        for (String value : new String[]{"http://prices.example", "https://user:secret@prices.example", "https://prices.example/path", "https://prices.example/?token=synthetic", "https://prices.example/#fragment"}) {
            assertThrows(IllegalArgumentException.class, () -> AddressPolicy.server(value));
        }
    }
    @Test public void collectorOnlyRunsOnTheExactLamodaHttpsOrigin() {
        assertTrue(AddressPolicy.lamoda("https://www.lamoda.ru/wishlist/"));
        assertTrue(AddressPolicy.lamoda("https://lamoda.ru/"));
        for (String value : new String[]{"http://lamoda.ru", "https://lamoda.ru.evil.example", "https://user@lamoda.ru", "file:///lamoda.ru", "https://lamoda.ru:444"}) assertFalse(AddressPolicy.lamoda(value));
    }
}
